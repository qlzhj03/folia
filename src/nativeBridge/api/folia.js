// 内置桥的调度器：页面侧发来的 FOLIA_API_REQUEST 在这里按路径分发到各平台的实现。
// 当前只带网易云；QQ / 酷狗 / 波点的接入各占一个 provider 分支与各自目录下的实现文件，
// 接入时在 handleFoliaApiRequest 里加分支即可（上游 folia-sonnet 的同名文件是全量版）。

import { eapiRequest } from './eapi.js';
import { weapiRequest, UA } from './weapi.js';
// 游客会话：桌面端由内嵌后端注册，安卓这边原先只回一个空 cookie，后面每个 weapi 请求
// 于是都不带 cookie（csrf_token 取不到，上游一律答 301），探索页每一栏都是空的。
// 具体实现放在这一家自己的目录下（桥的配额只数共享文件里出现的平台名）。
import { registerAnonymousCookie } from './netease/anonimous.js';
import { noteLibraryStep } from './libraryTrace.js';
import {
  getNeteaseCookie,
  hasNeteaseLogin,
  parseCookieString,
} from './cookies.js';
import {
  getLoginInfo,
  handleLoginQrCheck,
  handleLoginQrCreate,
  handleLoginQrKey,
  handleSongLike,
  handleSongLikeCheck,
  handleSongUrl,
  handleLyric,
} from './netease.js';

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value) !== '') return value;
  }
  return '';
}

function numberValue(...values) {
  const value = Number(firstValue(...values));
  return Number.isFinite(value) ? value : 0;
}

function parseInput(input) {
  const url = new URL(String(input?.path || input?.operation || '/'), 'https://folia.local');
  Object.entries(input?.query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
  let body = input?.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {
      body = {};
    }
  }
  if (!body || typeof body !== 'object') body = {};
  return { url, body, method: String(input?.method || 'GET').toUpperCase() };
}

// 探索页这一组请求的路径（见下面 --- Explore --- 那段）：留痕用，
// 页面空的时候先看诊断里有没有这几条。
const EXPLORE_PATHS = new Set([
  '/homepage/block/page',
  '/recommend/resource',
  '/toplist',
  '/simi/song',
  '/top/song',
  '/album/new',
  '/top/playlist',
]);

async function eapiJson(path, data, cookie) {
  const result = await eapiRequest(path, data || {}, cookie || '');
  const body = result?.body || {};
  if (result?.status >= 500) {
    throw new Error(body.message || body.msg || `Netease EAPI ${path} failed (${result.status})`);
  }
  return body;
}

/*
 * 走 weapi（网页端那套）而不是 eapi：下面「探索页」那一组在桌面端的内嵌后端里就是 weapi
 * （那份后端的同名模块里写的），安卓这边必须答出同样的形状，
 * 否则会出现「桌面能显示、安卓读不到」。
 *
 * 顺手补上 csrf_token —— weapi 这几个接口认它，缺了会答 `{code: 301}` 之类。
 * 这里**不抛错**：探索页要自己看 code（比如登录失效的 301 是「这一栏不显示」而不是
 * 整页失败），抛了反而把它变成了读不出来。
 */
/*
 * 未加密的 /api/ 网关兜底：同一条路径，参数挂在 query 上，cookie 走请求头。
 *
 * 它当初是**主路径**：那时 `weapi.js` 的 `RSA_MODULUS` 被写坏，weapi 一律答
 * 「HTTP 200 + 空 body」，而未加密这条老网关还答得出内容（`toplist`、
 * `homepage/block/page`、`album/new`、`v1/discovery/new/songs`、
 * `v1/discovery/recommend/resource` 都实测过）。
 *
 * 模数已经在 2026-10-21 修好（见 `weapi.js` 里那个常量的注释），所以现在 weapi 才是主路径，
 * 这条降级为**第二道防线**：哪天 weapi 又答不出东西，读接口还有一条退路，界面不至于整页空白。
 * 走了哪条路会留痕（`api:fallback`），线上再空着时能一眼看出是网关没了还是会话没带上。
 */
async function plainApiJson(path, data, cookie) {
  const query = new URLSearchParams();
  Object.entries(data || {}).forEach(([key, value]) => {
    // csrf_token 是 weapi 那套自己要的，放到 query 上只是噪声。
    if (value == null || value === '' || key === 'csrf_token') return;
    query.set(key, String(value));
  });
  const search = query.toString();
  let body = {};
  try {
    const resp = await fetch(`https://music.163.com${path}${search ? `?${search}` : ''}`, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        Referer: 'https://music.163.com/',
        Cookie: cookie || '',
        Accept: 'application/json',
      },
    });
    try {
      body = await resp.json();
    } catch (_) {
      body = {};
    }
  } catch (_) {
    body = {};
  }
  return body;
}

/** 什么都没答（空 body、非 JSON）＝网关这条路径没了，不是「没有内容」。 */
const isBlankAnswer = (answer) => !answer || typeof answer !== 'object' || Object.keys(answer).length === 0;

/**
 * 读一条：先走 weapi（主路径），答不出内容或会话不被认时改走未加密的 /api/。
 *
 * 只用于**读**（下面探索页那一组都是读）：写操作的路径不能靠 GET 兜底。兜底那条答不出
 * 内容时仍把 weapi 的原答案交回去 —— 于是最坏的情况与现在一样，不会更差。
 * 走了哪条路会留痕：线上再整页空着时，一眼看出是「网关没了」还是「会话没带」。
 */
async function readJson(path, data, cookie) {
  const answer = await weapiJson(path, data, cookie);
  if (!isBlankAnswer(answer) && answer.code !== 301 && answer.code !== 401 && answer.code !== 403) return answer;
  const plain = await plainApiJson(path, data, cookie);
  if (isBlankAnswer(plain)) return answer;
  noteLibraryStep('netease', 'api:fallback', { path, source: 'plain', code: answer?.code ?? null });
  return plain;
}

async function weapiJson(path, data, cookie) {
  const cookies = parseCookieString(cookie || '');
  const payload = Object.assign({}, data, { csrf_token: cookies.__csrf || '' });
  return await weapiRequest(path, payload, cookie || '');
}

function profileFromLoginInfo(info) {
  if (!info?.loggedIn) return null;
  return {
    userId: info.userId || '',
    nickname: info.nickname || 'Netease User',
    avatarUrl: info.avatar || '',
    backgroundUrl: '',
    vipType: info.vipType || 0,
    vipLevel: info.vipLevel || 'none',
  };
}

async function requireLoginInfo(cookie) {
  return await getLoginInfo(cookie);
}

async function handleLoginStatus(cookie) {
  const info = await requireLoginInfo(cookie);
  return {
    code: 200,
    data: {
      code: 200,
      account: info.loggedIn ? { id: info.userId || null } : null,
      profile: profileFromLoginInfo(info),
    },
  };
}

async function handleUserAccount(cookie) {
  const info = await requireLoginInfo(cookie);
  return {
    code: 200,
    account: info.loggedIn ? {
      id: info.userId || null,
      userName: info.nickname || '',
      type: 1,
      status: 0,
    } : null,
    profile: profileFromLoginInfo(info),
  };
}

async function handleSearch(url, cookie) {
  const keywords = String(firstValue(url.searchParams.get('keywords'), url.searchParams.get('s'))).trim();
  if (!keywords) return { code: 200, result: { songs: [], songCount: 0 } };
  const limit = Math.max(1, Math.min(100, numberValue(url.searchParams.get('limit'), 30)));
  const offset = Math.max(0, numberValue(url.searchParams.get('offset'), 0));
  const body = await eapiJson('/api/cloudsearch/pc', {
    s: keywords,
    type: 1,
    limit,
    offset,
    total: true,
  }, cookie);
  if (Array.isArray(body?.result?.songs) && body.result.songs.length > 0) return body;
  const fallback = await eapiJson('/api/search/pc', {
    s: keywords,
    type: 1,
    limit,
    offset,
  }, cookie);
  if (Array.isArray(fallback?.result?.songs) && fallback.result.songs.length > 0) return fallback;

  const response = await fetch('https://music.163.com/api/search/get/web', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://music.163.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams({
      s: keywords,
      type: '1',
      limit: String(limit),
      offset: String(offset),
      total: 'true',
    }).toString(),
  });
  if (!response.ok) return { code: response.status, result: { songs: [], songCount: 0 } };
  const publicBody = await response.json();
  return publicBody?.result ? publicBody : { code: 200, result: { songs: [], songCount: 0 } };
}

async function handleSongDetail(url, cookie) {
  const ids = String(firstValue(url.searchParams.get('ids'), url.searchParams.get('id')))
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return { code: 200, songs: [], privileges: [] };
  const detail = await eapiJson('/api/v3/song/detail', {
    c: JSON.stringify(ids.map((id) => ({ id }))),
  }, cookie);
  return {
    ...detail,
    code: Number(detail.code) || 200,
    songs: Array.isArray(detail.songs) ? detail.songs : [],
    privileges: Array.isArray(detail.privileges) ? detail.privileges : [],
  };
}

async function handleSongUrlV1(url, cookie) {
  const ids = String(firstValue(url.searchParams.get('id'), url.searchParams.get('ids')))
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isFinite(id) && id > 0);
  const level = String(firstValue(url.searchParams.get('level'), 'exhigh'));
  if (!ids.length) return { code: 200, data: [] };
  const data = await Promise.all(ids.map(async (id) => {
    const result = await handleSongUrl(id, cookie, level);
    return {
      id,
      url: result?.url || null,
      br: result?.br || 0,
      size: 0,
      md5: null,
      code: result?.url ? 200 : 404,
      expi: 1200,
      type: 'mp3',
      gain: 0,
      peak: 0,
      fee: 0,
      uf: null,
      payed: 0,
      flag: 0,
      canExtend: false,
      freeTrialInfo: result?.trial ? { start: 0, end: 0 } : null,
      level: result?.level || level,
      encodeType: 'mp3',
      channelLayout: null,
      freeTrialPrivilege: result?.restriction ? { resConsumable: false, userConsumable: false } : null,
      freeTimeTrialPrivilege: null,
      urlSource: 0,
      rightSource: 0,
      podcastCid: null,
      effectTypes: null,
      time: 0,
    };
  }));
  return { code: 200, data };
}

async function handleLyricNew(url, cookie) {
  const id = firstValue(url.searchParams.get('id'), url.searchParams.get('ids'));
  if (!id) return { code: 200, lrc: { lyric: '' }, tlyric: { lyric: '' }, yrc: { lyric: '' } };
  let body = {};
  try {
    body = await eapiJson('/api/song/lyric/v1', {
      id,
      cp: false,
      tv: 0,
      lv: 0,
      rv: 0,
      kv: 0,
      yv: 0,
      ytv: 0,
      yrv: 0,
    }, cookie);
  } catch (_) {
    const fallback = await handleLyric(id, cookie);
    body = {
      lrc: { lyric: fallback?.lyric || '' },
      tlyric: { lyric: fallback?.tlyric || '' },
      yrc: { lyric: fallback?.yrc || '' },
    };
  }
  return {
    ...body,
    code: Number(body.code) || 200,
    lrc: body.lrc || { lyric: '' },
    tlyric: body.tlyric || { lyric: '' },
    yrc: body.yrc || { lyric: '' },
  };
}

async function handleUserPlaylists(url, cookie) {
  const info = await requireLoginInfo(cookie);
  const uid = numberValue(url.searchParams.get('uid'), info.userId);
  if (!info.loggedIn || !uid) return { code: 200, playlist: [], more: false };
  const body = await eapiJson('/api/user/playlist', {
    uid,
    limit: numberValue(url.searchParams.get('limit'), 50),
    offset: numberValue(url.searchParams.get('offset'), 0),
  }, cookie);
  return {
    ...body,
    code: Number(body.code) || 200,
    playlist: Array.isArray(body.playlist) ? body.playlist : [],
  };
}

// 顺序一律按上游来：接口给什么顺序就往下传什么顺序，桥里不重排。
// （2026-10-13 撤掉了之前那版「按 trackIds 归位」—— 排序方法恢复上游，只有酷狗按
//  RemnantCloudGodofWar/folia-android 的修法单独处理。）

async function handlePlaylistDetail(url, cookie) {
  const id = firstValue(url.searchParams.get('id'), url.searchParams.get('pid'));
  if (!id) return { code: 200, playlist: null };
  const body = await eapiJson('/api/v6/playlist/detail', { id, n: 1000, s: 8 }, cookie);
  return { ...body, code: Number(body.code) || 200 };
}

async function handlePlaylistTrackAll(url, cookie) {
  const detail = await handlePlaylistDetail(url, cookie);
  const playlist = detail?.playlist || {};
  return {
    code: Number(detail.code) || 200,
    songs: Array.isArray(playlist.tracks) ? playlist.tracks : [],
    privileges: Array.isArray(playlist.privileges) ? playlist.privileges : [],
    playlist,
  };
}

async function handleArtistDetail(url, cookie) {
  const id = firstValue(url.searchParams.get('id'), url.searchParams.get('artistId'));
  if (!id) return { code: 200, data: null };
  const body = await eapiJson('/api/artist/head/info/get', { id }, cookie);
  return { ...body, code: Number(body.code) || 200 };
}

async function handleArtistTopSongs(url, cookie) {
  const id = firstValue(url.searchParams.get('id'), url.searchParams.get('artistId'));
  if (!id) return { code: 200, songs: [], privileges: [] };
  const body = await eapiJson('/api/artist/top/song', { id }, cookie);
  return {
    ...body,
    code: Number(body.code) || 200,
    songs: Array.isArray(body.songs) ? body.songs : [],
    privileges: Array.isArray(body.privileges) ? body.privileges : [],
  };
}

async function handleArtistSongs(url, cookie) {
  const id = firstValue(url.searchParams.get('id'), url.searchParams.get('artistId'));
  if (!id) return { code: 200, songs: [], privileges: [] };
  const body = await eapiJson('/api/v1/artist/songs', {
    id,
    order: String(firstValue(url.searchParams.get('order'), 'hot')),
    limit: numberValue(url.searchParams.get('limit'), 50),
    offset: numberValue(url.searchParams.get('offset'), 0),
  }, cookie);
  return {
    ...body,
    code: Number(body.code) || 200,
    songs: Array.isArray(body.songs) ? body.songs : [],
    privileges: Array.isArray(body.privileges) ? body.privileges : [],
  };
}

async function handleArtistAlbums(url, cookie) {
  const id = firstValue(url.searchParams.get('id'), url.searchParams.get('artistId'));
  if (!id) return { code: 200, hotAlbums: [], more: false };
  const body = await weapiJson(`/api/artist/albums/${id}`, {
    limit: numberValue(url.searchParams.get('limit'), 30),
    offset: numberValue(url.searchParams.get('offset'), 0),
    total: true,
  }, cookie);
  return {
    ...body,
    code: Number(body.code) || 200,
    hotAlbums: Array.isArray(body.hotAlbums) ? body.hotAlbums : [],
    more: !!body.more,
  };
}

async function handleAlbum(url, cookie) {
  const id = firstValue(url.searchParams.get('id'), url.searchParams.get('albumId'));
  if (!id) return { code: 200, album: null, songs: [] };
  const body = await weapiJson(`/api/v1/album/${id}`, {}, cookie);
  return {
    ...body,
    code: Number(body.code) || 200,
    songs: Array.isArray(body.songs) ? body.songs : [],
    privileges: Array.isArray(body.privileges) ? body.privileges : [],
  };
}

async function handleLikedList(url, cookie) {
  const info = await requireLoginInfo(cookie);
  if (!info.loggedIn || !info.userId) return { code: 200, ids: [] };
  const body = await weapiJson('/api/song/like/get', { uid: info.userId }, cookie);
  const ids = body?.ids || body?.data?.ids || [];
  return { ...body, code: Number(body.code) || 200, ids: Array.isArray(ids) ? ids : [] };
}

async function handleLike(url, body, cookie) {
  const id = firstValue(url.searchParams.get('id'), body.id);
  const like = String(firstValue(url.searchParams.get('like'), body.like, 'true')) !== 'false';
  return await handleSongLike(id, like, cookie);
}

async function handleLikeCheck(url, cookie) {
  const ids = String(firstValue(url.searchParams.get('ids'), url.searchParams.get('id')))
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return await handleSongLikeCheck(ids, cookie);
}

async function handleDailyRecommend(url, cookie) {
  const afresh = String(firstValue(url.searchParams.get('afresh'), 'false')) === 'true';
  const params = { limit: 30, offset: 0, total: true, n: 1000, ...(afresh ? { afresh: true } : {}) };
  // 每日推荐试两条上游路径、两种签名：不同客户端版本上 v3 eapi 可能被拒（code 400/301），
  // 旧接口或 weapi 仍能回同一批歌。全部失败才报错，并留痕说明试过哪些。
  const attempts = [
    { name: 'eapi-v3', run: () => eapiJson('/api/v3/discovery/recommend/songs', {}, cookie) },
    { name: 'weapi-v3', run: () => weapiJson('/api/v3/discovery/recommend/songs', params, cookie) },
    { name: 'eapi-legacy', run: () => eapiJson('/api/recommend/songs', {}, cookie) },
    { name: 'weapi-legacy', run: () => weapiJson('/api/recommend/songs', params, cookie) },
  ];
  const tried = [];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const body = await attempt.run();
      const songs = Array.isArray(body?.data?.dailySongs) ? body.data.dailySongs
        : Array.isArray(body?.dailySongs) ? body.dailySongs
          : Array.isArray(body?.songs) ? body.songs : [];
      noteLibraryStep('netease', 'explore:daily:source', { via: attempt.name, songs: songs.length, code: body?.code });
      return body;
    } catch (error) {
      tried.push(attempt.name);
      lastError = error;
    }
  }
  noteLibraryStep('netease', 'explore:daily:failed', { tried: tried.join(',') });
  throw lastError || new Error('Daily recommendation request failed');
}

async function handleHistoryRecommend(url, cookie) {
  const date = url.searchParams.get('date');
  const path = date ? '/api/history/recommend/songs/detail' : '/api/history/recommend/songs';
  return await eapiJson(path, date ? { date } : {}, cookie);
}

async function handlePersonalFm(url, cookie) {
  const mode = url.searchParams.get('mode');
  if (!mode || mode === 'DEFAULT') {
    return await eapiJson('/api/v1/radio/get', {}, cookie);
  }
  const body = { mode };
  const submode = url.searchParams.get('submode');
  if (submode) body.submode = submode;
  try {
    const result = await eapiJson('/api/personal/fm/mode', body, cookie);
    if (Array.isArray(result?.data) && result.data.length) return result;
  } catch (_) {}
  return await eapiJson('/api/v1/radio/get', {}, cookie);
}

async function handlePlaylistTracks(url, body, cookie) {
  const op = String(firstValue(url.searchParams.get('op'), body.op, 'add'));
  const pid = firstValue(url.searchParams.get('pid'), body.pid);
  const tracks = firstValue(url.searchParams.get('tracks'), body.tracks);
  return await eapiJson('/api/playlist/tracks', { op, pid, tracks }, cookie);
}

async function handleSubscribe(url, body, cookie, path) {
  const id = firstValue(url.searchParams.get('id'), body.id);
  const t = numberValue(url.searchParams.get('t'), body.t, 1);
  return await eapiJson(path, { id, t }, cookie);
}

export async function handleFoliaApiRequest(input) {
  const { url, body, method } = parseInput(input);
  // ⚠️ 只认原生 cookie 罐是不够的：登录是渲染层自己存的会话值，罐里可能根本没有 ——
  // 那这边就等于没登录，weapi 一律答 `{code: 301}`；而 weapiJson 为了让整页不至于失败
  // 是**不抛错**的，于是每一栏都空着，探索页看上去就是「空的」而不是「读不出来」。
  // 只有带着登录态的那个才优先：渲染层没登录时会拿匿名 cookie 来，那不能盖住罐里真登录的。
  // （这一行要在 params 声明之前，直接用 url.searchParams，避免压缩后的 TDZ。）
  const sent = firstValue(url.searchParams.get('cookie'), body.cookie);
  const cookie = (sent && hasNeteaseLogin(sent) ? sent : '') || await getNeteaseCookie();
  const path = url.pathname;
  const params = url.searchParams;

  if (path === '/register/anonimous') {
    // 真的去注册一个游客：拿到的是带 MUSIC_A / __csrf 的那份 cookie，weapi 才答得出东西。
    // 拿不到就还是空串，与原来一样 —— 并不比空壳更差。
    const guest = await registerAnonymousCookie();
    noteLibraryStep('netease', 'auth:anonimous', { ok: guest ? 'yes' : 'no' });
    return { code: 200, cookie: guest, anonymous: true };
  }
  if (path === '/login/status') return await handleLoginStatus(cookie);
  if (path === '/user/account') return await handleUserAccount(cookie);
  if (path === '/logout') return { code: 200 };
  if (path === '/login/qr/key') {
    const result = await handleLoginQrKey();
    return { code: 200, data: { code: 200, unikey: result.key } };
  }
  if (path === '/login/qr/create') {
    const key = firstValue(params.get('key'), body.key);
    const result = await handleLoginQrCreate(key);
    return { code: 200, data: { qrimg: result.qrimg || result.img, qrurl: result.url } };
  }
  if (path === '/login/qr/check') {
    const key = firstValue(params.get('key'), body.key);
    return await handleLoginQrCheck(key);
  }
  if (path === '/cloudsearch' || path === '/search') return await handleSearch(url, cookie);
  if (path === '/song/detail') return await handleSongDetail(url, cookie);
  if (path === '/song/url/v1' || path === '/song/url') return await handleSongUrlV1(url, cookie);
  if (path === '/lyric/new' || path === '/lyric') return await handleLyricNew(url, cookie);
  if (path === '/song/chorus') {
    const id = firstValue(params.get('id'), body.id);
    return await eapiJson('/api/song/chorus', { id }, cookie);
  }
  if (path === '/user/playlist') return await handleUserPlaylists(url, cookie);
  if (path === '/playlist/detail') return await handlePlaylistDetail(url, cookie);
  if (path === '/playlist/track/all') return await handlePlaylistTrackAll(url, cookie);
  if (path === '/playlist/tracks') return await handlePlaylistTracks(url, body, cookie);
  if (path === '/playlist/subscribe') return await handleSubscribe(url, body, cookie, '/api/playlist/subscribe');
  if (path === '/playlist/detail/dynamic') {
    const id = firstValue(params.get('id'), body.id);
    return await eapiJson('/api/playlist/detail/dynamic', { id }, cookie);
  }
  if (path === '/album') return await handleAlbum(url, cookie);
  if (path === '/album/sub') return await handleSubscribe(url, body, cookie, '/api/album/sub');
  if (path === '/album/sublist') {
    return await weapiJson('/api/album/sublist', {
      limit: numberValue(params.get('limit'), 25),
      offset: numberValue(params.get('offset'), 0),
    }, cookie);
  }
  if (path === '/album/detail/dynamic') {
    const id = firstValue(params.get('id'), body.id);
    return await eapiJson('/api/album/detail/dynamic', { id }, cookie);
  }
  if (path === '/artist/detail') return await handleArtistDetail(url, cookie);
  if (path === '/artist/top/song') return await handleArtistTopSongs(url, cookie);
  if (path === '/artist/songs') return await handleArtistSongs(url, cookie);
  if (path === '/artist/album') return await handleArtistAlbums(url, cookie);
  if (path === '/likelist') return await handleLikedList(url, cookie);
  if (path === '/like') return await handleLike(url, body, cookie);
  if (path === '/like/check') return await handleLikeCheck(url, cookie);
  if (path === '/recommend/songs') return await handleDailyRecommend(url, cookie);
  if (path === '/recommend/songs/dislike') {
    const id = firstValue(params.get('id'), body.id);
    return await eapiJson('/api/recommend/songs/dislike', { id }, cookie);
  }
  if (path === '/history/recommend/songs' || path === '/history/recommend/songs/detail') {
    return await handleHistoryRecommend(url, cookie);
  }
  if (path === '/personal_fm' || path === '/personal/fm/mode') return await handlePersonalFm(url, cookie);
  if (path === '/personalized') {
    return await eapiJson('/api/personalized/playlist', {
      limit: numberValue(params.get('limit'), 35),
    }, cookie);
  }
  if (path === '/fm_trash') {
    const id = firstValue(params.get('id'), body.id);
    return await eapiJson('/api/radio/trash', { id }, cookie);
  }
  if (path === '/scrobble/v1') return { code: 200 };
  if (path === '/user/cloud') return { code: 200, data: [], songs: [] };
  if (path === '/user/cloud/detail') return { code: 200, data: [], songs: [] };
  if (path === '/cloud/lyric/get') return { code: 200, lyric: '', lrc: { lyric: '' } };
  if (path === '/song/copyright/rcmd') return { code: 200, data: null };

  /*
   * --- Explore ---
   *
   * 探索页那一组。安卓上没有本地后端，请求全走这个桥 —— 而这一组一直没实现，
   * 于是整个探索页读不出来（日志里就是 `Folia bridge does not implement ...`）。
   * 目标路径照桌面端内嵌后端那份写（它模块目录下的同名文件），答出来的字段必须对得上
   * 探索页适配器读的那几个：
   *   /homepage/block/page → data.blocks
   *   /recommend/resource  → recommend
   *   /toplist             → list
   *   /simi/song           → songs
   *   /top/song            → data
   *   /album/new           → albums
   *   /top/playlist        → playlists
   */
  // 探索页这一组走的路由：留痕能看出哪一条被问过（页面空却一条都没有 = 请求根本没到桥）。
  // 顺带记 cookie 的长度：0 就是这次请求压根没带登录态，上游只会答 301。
  if (EXPLORE_PATHS.has(path)) noteLibraryStep('netease', 'explore:route', { path, cookie: cookie ? cookie.length : 0 });
  if (path === '/homepage/block/page') {
    // 没有 cursor 时**绝不能带 `cursor: ''`**：首页区块这条带上空游标就答不出 blocks，
    // 探索页于是只剩每日推荐那一栏（看着就是「页面是空的」）。
    const cursor = firstValue(params.get('cursor'));
    return await readJson('/api/homepage/block/page', {
      refresh: String(firstValue(params.get('refresh'), 'false')) !== 'false',
      ...(cursor ? { cursor } : {}),
    }, cookie);
  }
  if (path === '/recommend/resource') {
    // 每日推荐歌单：weapi 这条账号类接口常只答 `{code: 301}`（csrf 对不上或认成未登录），
    // 而 weapiJson 为了不让整页失败是**不抛错**的 —— 光靠 try/catch 换不了路，这一栏会一直 0 张。
    // 所以「没答出 recommend 就换 eapi 再问一次」，网络层真抛错时同样换路。
    try {
      const answer = await readJson('/api/v1/discovery/recommend/resource', {}, cookie);
      if (Array.isArray(answer?.recommend) || Array.isArray(answer?.data?.recommend)) return answer;
      noteLibraryStep('netease', 'explore:daily-playlists:fallback', { code: answer?.code });
    } catch (error) {
      noteLibraryStep('netease', 'explore:daily-playlists:fallback', {
        message: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
      });
    }
    return await eapiJson('/api/v1/discovery/recommend/resource', {}, cookie);
  }
  if (path === '/toplist') return await readJson('/api/toplist', {}, cookie);
  if (path === '/simi/song') {
    return await readJson('/api/v1/discovery/simiSong', {
      songid: numberValue(params.get('id')),
      limit: numberValue(params.get('limit'), 50),
      offset: numberValue(params.get('offset')),
    }, cookie);
  }
  // 新歌速递：`type` 是地区（0 全部 / 7 华语 / 96 欧美 / 8 日本 / 16 韩国）。
  if (path === '/top/song') {
    // 新歌速递要明说一页多少条：不给 limit/offset 时上游只回很少几首，这一栏几乎是空的。
    return await readJson('/api/v1/discovery/new/songs', {
      areaId: numberValue(params.get('type')),
      limit: numberValue(params.get('limit'), 100),
      offset: numberValue(params.get('offset'), 0),
      total: true,
    }, cookie);
  }
  if (path === '/album/new') {
    return await readJson('/api/album/new', {
      limit: numberValue(params.get('limit'), 30),
      offset: numberValue(params.get('offset')),
      area: firstValue(params.get('area'), 'ALL'),
      total: true,
    }, cookie);
  }
  if (path === '/top/playlist') {
    return await readJson('/api/playlist/list', {
      cat: firstValue(params.get('cat'), '全部'),
      order: firstValue(params.get('order'), 'hot'),
      limit: numberValue(params.get('limit'), 30),
      offset: numberValue(params.get('offset')),
      total: true,
    }, cookie);
  }

  return {
    __foliaBridgeError: 'ROUTE_NOT_IMPLEMENTED',
    path,
    method,
    message: `Folia bridge does not implement ${method} ${path}`,
  };
}

export async function getFoliaBridgeStatus() {
  const cookie = await getNeteaseCookie();
  const info = await getLoginInfo(cookie);
  return {
    netease: {
      loggedIn: !!info?.loggedIn,
      nickname: info?.nickname || '',
      avatar: info?.avatar || '',
      hasCookie: hasNeteaseLogin(cookie),
    },
  };
}
