/**
 * dsh-ui-miniskin —— 宿主半边（Node 侧）
 *
 * 这个插件只做两件事，都走「页面注入 + 自有路由」这条在真实插件生态里被验证过的路
 * （不用 dsh.client / slot 系统，理由见 DSH-插件开发方法.md §1）：
 *
 * 1. **启动动画**：往页面 `<head>` 注入一小段「绘制前脚本」。它必须比宿主的首屏
 *    更早执行，才能压住宿主的白色首帧、并且从第一帧就画出品牌底图。
 * 2. **界面壁纸**：往页面注入固定层壁纸 + 一组主题令牌覆盖，让宿主界面「透」出来。
 *
 * 三条必须遵守的时机/形态规则（缺一条就会「装了但页面什么都没有」）：
 *
 * 1. 注入行必须在 `apply()` **一开始**注册，且不依赖任何服务。桌面端的注入表是
 *    启动时**一次性收集**的；订阅晚于那次收集，这一行就永远进不了表。
 * 2. 内联进页面的必须是**极小的脚本**，前端本体走本插件自己的路由。
 * 3. 可选服务用 `root.inject([...], cb)`，不要用对象级 `inject`（后者会推迟 apply）。
 *
 * 偏好存在 `$DSH_HOME/.dsh-ui-miniskin.json`（以包名为前缀，见踩坑记录 B6）。
 * 所有路由都**每次请求现读偏好**，所以改完偏好刷新页面即可生效，不必重启客户端；
 * 只有改本文件（宿主半边）才需要重启。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-ui-miniskin'
const LEGACY_PACKAGE = 'dsh-ui-beautify' // 旧包名：仅用于偏好/图片目录的一次性迁移
const VERSION = '1.0.0'

/** 插件自身的资源目录（前端本体所在处）。 */
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const widgetPath = join(packageDir, 'assets', 'widget.js')
/** 标题栏自检页（复刻宿主 preload 的取色算法，用来验证"系统按钮底色"这一条）。 */
const titlebarProbePath = join(packageDir, 'assets', 'titlebar-probe.html')

/** 全局唯一的路径前缀：本插件的全部路由都挂在它下面。 */
const BASE = '/' + PACKAGE

const ROUTES = {
  widget: BASE + '/widget.js',
  prefs: BASE + '/prefs.json',
  report: BASE + '/report.json',
  health: BASE + '/health.json',
  titlebar: BASE + '/titlebar-probe.html',
  imageUpload: BASE + '/image-upload',
  // 注意：prefix 必须**不带**尾部斜杠 —— 宿主匹配规则是
  // `pathname === prefix || pathname.startsWith(prefix + '/')`，
  // 带斜杠的 '/image/' 会让 '/image/wall-….png' 永远匹配不上（实测 404）。
  imagePrefix: BASE + '/image',
}

/** 「选择文件」上传的图片存放目录（在 $DSH_HOME 下，重启后依然在）。 */
const IMAGES_DIR = join(dshHome(), '.' + PACKAGE + '-images')
const LEGACY_IMAGES_DIR = join(dshHome(), '.' + LEGACY_PACKAGE + '-images')
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i
const IMAGE_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
}
/** 单张图片上限（字节）。 */
const IMAGE_MAX = 16 * 1024 * 1024

/** 把任意文件名清洗成「纯安全段.扩展」；扩展不在白名单时补 .jpg。 */
function sanitizeImageName(name) {
  const base = String(name || 'wallpaper').replace(/[^\w.-]+/g, '').slice(0, 60) || 'wallpaper'
  const extMatch = IMAGE_EXT_RE.exec(base)
  if (extMatch) return base
  return base + '.jpg'
}

/** 只允许 [A-Za-z0-9._-]，杜绝路径穿越。 */
function safeImageFileName(name) {
  const clean = String(name || '').replace(/[^\w.-]/g, '').slice(0, 80)
  return clean === String(name) ? clean : ''
}

// ---------------------------------------------------------------- 偏好

/** 解析 $DSH_HOME（默认 ~/.dsh）。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const home = process.env.USERPROFILE || process.env.HOME || '.'
  return join(home, '.dsh')
}

const PREFS_FILE = join(dshHome(), '.' + PACKAGE + '.json')
const LEGACY_PREFS_FILE = join(dshHome(), '.' + LEGACY_PACKAGE + '.json')
/** 注入行的 text 必须是**字符串**（宿主把它当纯 JSON 数据喂给两种渲染器）。 */
const oneLine = (lines) => lines.join('')

/**
 * 从旧包名（dsh-ui-beautify）一次性迁移到新包名（dsh-ui-miniskin）：
 * - 偏好文件：不存在新文件且存在旧文件时，把旧内容搬过去，并把图片地址前缀
 *   /dsh-ui-beautify/image/ 改写成 /dsh-ui-miniskin/image/（路由已改名）；
 * - 图片目录：把旧目录里的图片文件搬到新目录。
 * 幂等：只搬一次，旧文件/旧目录保留不删。
 */
function migrateFromLegacy() {
  try {
    if (!existsSync(PREFS_FILE) && existsSync(LEGACY_PREFS_FILE)) {
      const raw = readFileSync(LEGACY_PREFS_FILE, 'utf-8')
      const rewritten = raw.replace(
        new RegExp('/' + LEGACY_PACKAGE + '/image/', 'g'),
        '/' + PACKAGE + '/image/',
      )
      writeFileSync(PREFS_FILE, rewritten)
    }
    if (!existsSync(IMAGES_DIR) && existsSync(LEGACY_IMAGES_DIR)) {
      mkdirSync(IMAGES_DIR, { recursive: true })
      for (const name of readdirSync(LEGACY_IMAGES_DIR)) {
        const from = join(LEGACY_IMAGES_DIR, name)
        const to = join(IMAGES_DIR, name)
        if (!existsSync(to)) renameSync(from, to)
      }
    }
  } catch (err) {
    console.error('[' + PACKAGE + '] 旧偏好迁移失败：' + String(err?.message || err))
  }
}
migrateFromLegacy()

/**
 * 壁纸预设。形状与前端 `assets/widget.js` 里的 `PRESETS` 一一对应
 * （前端用按名取 CSS 背景的查表法，两端只共享「名字」这一个契约）。
 */
const PRESETS = ['aurora', 'nebula', 'dusk', 'ocean', 'forest', 'sakura', 'paper', 'carbon', 'image']

/** 宿主表面处理档位（与前端 `assets/widget.js` 的 SURFACE_MODES 一一对应）。 */
const SURFACE_MODES = ['embed', 'frost', 'clear', 'tint', 'off']

/** 启动动画顶部条带的三种画法（与前端 `assets/widget.js` 的 TITLEBAR_MODES 一一对应）。 */
const TITLEBAR_MODES = ['flat', 'gradient', 'none']

/**
 * 启动动画的顶部色调。
 *
 * 这个值必须与下面的渐变定义**对应**：径向渐变
 * `radial-gradient(1100px 720px at 50% 18%, #2a3560 0%, #151a2c 46%, #0c0e16 100%)`
 * 在顶部中央（y=0）的合成色就约等于 `#161b2f`。
 *
 * 为什么重要（踩过两次）：
 * - 窗口标题栏那三个系统按钮的底色由 `--dsw-specific-sidebar-fill` 决定。
 *   钉成系统兜底色 `#1b1b1c` 会与动画顶部 `#161b2f` 有色差，按钮反而更显眼。
 * - 启动动画**永远是这套深蓝底**，所以标题栏要**无条件**钉成这个深色。
 *   我一度按"系统主题"分深浅两套 —— 实测用户系统是浅色、应用是深色时，
 *   标题栏钉成了浅色 `#e8ecfa`，三个按钮带着深色图标坐在深蓝动画上方，
 *   看起来就是"还是原来的颜色"。浅色变体直接删掉，不再跟随系统。
 */
const TITLEBAR_TINT_DARK = '#161b2f'

/**
 * 官方鲸鱼图标路径（DeepSeek 官方 Logo，取自宿主 dsh-client-ui-primitives 的
 * FishLogo：viewBox 23.16 × 17.04）。启动动画里以官方黑色（#101319）
 * 画在白色圆角底块上。
 */
const WHALE_PATH = 'M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z'

/** 默认偏好：一眼能看出效果，但不过分抢戏。 */
const DEFAULTS = {
  // 壁纸
  wallpaper: true,
  preset: 'aurora',
  mode: 'auto', // auto | light | dark
  image: '',
  dim: 22, // 深色遮罩 0-70，压住壁纸亮度让文字更稳
  saturate: 100, // 0-160
  // 宿主界面透明化
  transparency: 44, // 0-100：越大壁纸越透出来
  blur: 0, // 0-32px：输入卡片磨砂。默认 0 = 卡片与周围同参、无分界；调大 = 独立磨砂面板（会有可见分界）
  // 表面处理档位：
  //   embed  壁纸内嵌 —— 默认。把壁纸画在宿主自己的表面上，不动层叠、不动布局，最稳
  //   frost  毛玻璃   —— 宿主表面半透明 + backdrop-filter
  //   clear  全透明
  //   tint   淡色调
  //   off    保持原样
  surface: 'embed',
  vignette: true, // 四周暗角
  // 启动动画
  splash: true,
  splashMs: 1100, // 最短展示时间
  splashLogo: true, // 显示 Logo 标记
  splashBar: true, // 显示进度条
  splashText: '', // 自定义副标题（留空用内置文案）
  // 启动动画顶部（窗口标题栏那 40px）怎么处理：
  //   flat     画一条与系统按钮底色一致的实色条带（最稳，推荐）
  //   gradient 条带改用动画顶部的渐变色调，让按钮看起来"浮在动画里"
  //   none     不画条带，让渐变直接铺到顶
  titlebar: 'flat',
  // 日常使用时的窗口标题栏（最上面那 40px）：是否融入壁纸。
  // true = 把标题栏底色设成透明，露出下面的壁纸，右上角系统按钮直接浮在皮肤上。
  // 宿主 preload 会把 --dsw-specific-sidebar-fill 的计算值经 IPC 交给主进程
  // （setTitleBarOverlay），所以改这个变量标题栏就会实时跟着变。
  titlebarBlend: false,
  // 调试开关（默认关）：1 = 打开页面就 dump 一次宿主 DOM；仅用于开发期排查渲染问题
  probe: false,
}

const num = (value, min, max, fallback) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

/** 清洗任意输入成合法偏好；任何异常都回落到默认值（坏文件不该让插件失效）。 */
function sanitize(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const out = {}
  out.wallpaper = bool(raw.wallpaper, DEFAULTS.wallpaper)
  out.preset = PRESETS.includes(raw.preset) ? raw.preset : DEFAULTS.preset
  out.mode = ['auto', 'light', 'dark'].includes(raw.mode) ? raw.mode : DEFAULTS.mode
  // 只做长度与协议层面的粗筛；真正的图片可达性由浏览器决定（加载失败会退回渐变）
  out.image = typeof raw.image === 'string' ? raw.image.trim().slice(0, 600) : DEFAULTS.image
  out.dim = num(raw.dim, 0, 70, DEFAULTS.dim)
  out.saturate = num(raw.saturate, 0, 160, DEFAULTS.saturate)
  out.transparency = num(raw.transparency, 0, 100, DEFAULTS.transparency)
  out.blur = num(raw.blur, 0, 32, DEFAULTS.blur)
  out.surface = SURFACE_MODES.includes(raw.surface) ? raw.surface : DEFAULTS.surface
  out.vignette = bool(raw.vignette, DEFAULTS.vignette)
  out.splash = bool(raw.splash, DEFAULTS.splash)
  out.splashMs = num(raw.splashMs, 0, 5000, DEFAULTS.splashMs)
  out.splashLogo = bool(raw.splashLogo, DEFAULTS.splashLogo)
  out.splashBar = bool(raw.splashBar, DEFAULTS.splashBar)
  out.splashText =
    typeof raw.splashText === 'string' ? raw.splashText.replace(/[\r\n\t]/g, ' ').slice(0, 40) : DEFAULTS.splashText
  out.titlebar = TITLEBAR_MODES.includes(raw.titlebar) ? raw.titlebar : DEFAULTS.titlebar
  out.titlebarBlend = bool(raw.titlebarBlend, DEFAULTS.titlebarBlend)
  out.probe = bool(raw.probe, DEFAULTS.probe)
  return out
}

/** 读偏好：文件不存在/损坏都回落到默认值。 */
function readPrefs() {
  try {
    return sanitize(JSON.parse(readFileSync(PREFS_FILE, 'utf8')))
  } catch (err) {
    /* 首次运行或文件损坏：用默认值 */
  }
  return sanitize(null)
}

/** 写偏好：先清洗再落盘，保证磁盘上永远是合法值。 */
function writePrefs(input) {
  const next = sanitize(input)
  writeFileSync(PREFS_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

// ---------------------------------------------------------------- 注入行

/**
 * 把数据安全地内联进 `<script>`。
 *
 * 只做一件事：把 `<`、`>`、行分隔符转成 `\uXXXX`。这样任何用户可控字符串
 * （自定义副标题、图片 URL）都不可能提前闭合脚本元素或伪造标签。
 * JSON.stringify 的输出本身是合法 JS 表达式，转义后依然合法。
 */
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * 前端本体是无依赖的 classic script，用「单行、极小」的行文本注入最稳：
 * 注入行的 `text` 必须是字符串，且不能依赖宿主如何缩进它。
 */
function bootstrapText() {
  return oneLine([
    '(function(){',
    'try{',
    'var d=document.body||document.head||document.documentElement;',
    'if(!d)return;',
    'var s=document.createElement("script");',
    's.src="' + ROUTES.widget + '";',
    's.async=false;',
    's.onerror=function(){};',
    'd.appendChild(s);',
    '}catch(e){}',
    '})()',
  ])
}

/**
 * 「绘制前」脚本：必须出现在 `<head>` 里、越早越好。
 *
 * 它做四件事：
 * 1. 解析本插件偏好，挂到 `globalThis.__DSH_UI_MINISKIN__`（前端本体复用同一份）；
 * 2. 在**宿主首个样式表生效前**给 `<html>` 打上 `data-dshb`，于是壁纸/首帧配色
 *    从第一帧就成立 —— 不这样做的话会先闪一下宿主白底再变暗；
 * 3. 用一张不透明的品牌底图铺满视口（否则启动动画会漏出宿主白色首帧）；
 * 4. 铺启动动画的骨架（进度条与文字由前端本体接管）。
 *
 * 全部逻辑包在 try/catch 里：注入器自己绝不能抛错。
 */
function prePaintText(prefs) {
  const config = {
    version: VERSION,
    wallpaper: prefs.wallpaper,
    mode: prefs.mode,
    preset: prefs.preset,
    image: prefs.image,
    dim: prefs.dim,
    saturate: prefs.saturate,
    transparency: prefs.transparency,
    blur: prefs.blur,
    surface: prefs.surface,
    vignette: prefs.vignette,
    splash: prefs.splash,
    splashMs: prefs.splashMs,
    splashLogo: prefs.splashLogo,
    splashBar: prefs.splashBar,
    splashText: prefs.splashText,
    titlebar: prefs.titlebar,
    titlebarBlend: prefs.titlebarBlend,
    probe: prefs.probe,
  }

  return oneLine([
    '(function(){',
    'var CFG=' + safeJson(config) + ';',
    'globalThis.__DSH_UI_MINISKIN__=CFG;',
    'try{',
    'var h=document.documentElement;',
    'if(!h)return;',
    'h.setAttribute("data-dshb","1");',
    'var dark=CFG.mode==="dark"?true:(CFG.mode==="light"?false:',
    '(window.matchMedia&&window.matchMedia("(prefers-color-scheme:dark)").matches));',
    'h.setAttribute("data-dshb-dark",dark?"1":"0");',
    'if(CFG.wallpaper){',
    'h.setAttribute("data-dshb-wall","1");',
    'h.setAttribute("data-dshb-mode",CFG.mode||"auto");',
    'h.setAttribute("data-dshb-vignette",CFG.vignette?"1":"0");',
    'h.style.setProperty("--dshb-transparency",String(CFG.transparency/100));',
    'h.style.setProperty("--dshb-blur",CFG.blur+"px");',
    '}',
    'if(!CFG.splash)return;',
    'var css=document.createElement("style");',
    'css.id="dshb-prepaint-style";',
    // 宿主首帧的底色。这是唯一需要"比宿主更早"的一条：
    // 宿主的 <head> 内联样式会先画一版底色，晚一步就会闪白。
    // 刻意**不在这里**把 body 设成透明 —— 换档/关壁纸时要能立刻撤回，
    // 而这段脚本只在启动时执行一次（详见 assets/widget.js 里 body 的壁纸规则）。
    //
    // 顺带把「窗口标题栏」的底色对齐到启动动画的顶部色调。为什么需要：
    // Windows 上主窗口用 `titleBarStyle:"hidden"` + `titleBarOverlay`，右上角那三个系统
    // 按钮（最小化/最大化/关闭）画在网页**上面**；它们的底色由 preload 从
    // `--dsw-specific-sidebar-fill` 读出来、经 IPC 交给主进程（实测 preload 里就是
    // `probe.style.cssText="...background-color:var(--dsw-specific-sidebar-fill)..."`）。
    //
    // 三个必须踩对的点：
    // ① **钉的颜色必须等于动画顶部的合成色**。#161b2f == 渐变顶部，无接缝。
    // ② **必须钉在 body 上、不能只钉 html**。宿主的主题令牌就定义在 `body{...}` 里
    //    （深色档是 `body[data-ds-dark-theme]{...}`），子元素继承的是 body 的值；
    //    只写 `html[data-dshb-splash]` 会被 body 的定义直接盖掉。
    // ③ **无条件钉深色**。启动动画永远是深蓝底；按系统主题分深浅两套时，
    //    浅色系统 + 深色应用会得到浅色标题栏配深色动画（实测就是这轮用户的场景），
    //    等于没修。所以浅色变体已删除。
    'css.textContent="html[data-dshb-splash=\\"1\\"] body{--dsw-specific-sidebar-fill:' + TITLEBAR_TINT_DARK + ';--dsw-alias-label-primary:#f9fafb}"',
    '+"html[data-dshb-splash=\\"1\\"] body[data-ds-dark-theme]{--dsw-specific-sidebar-fill:' + TITLEBAR_TINT_DARK + ';--dsw-alias-label-primary:#f9fafb}"',
    '+"html[data-dshb] body{background:#0f1115!important}"',
    '+"html[data-dshb][data-dshb-dark=\\"1\\"] body{background:#080a10!important}"',
    '+"#dshb-splash{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;"',
    // 渐变的光心放到 y=18%：这样**顶部中央的合成色正好等于 TITLEBAR_TINT**，
    // 钉在标题栏上的颜色与它无缝相接，三个按钮就"沉"进动画里了。
    '+"background:#0f1115;background:radial-gradient(1100px 720px at 50% 18%,#2a3560 0%,#151a2c 46%,#0c0e16 100%);"',
    '+"color:#e9edf7;font-family:system-ui,-apple-system,\\"Segoe UI\\",\\"Microsoft YaHei\\",sans-serif;"',
    '+"opacity:0;animation:dshb-in .26s ease forwards}"',
    '+"@keyframes dshb-in{from{opacity:0}to{opacity:1}}"',
    // 顶部 40px「标题栏条带」。三种画法由 data-tb 控制：
    //   flat（默认） 与系统按钮底色同色 → 按钮看起来就在启动动画自己的标题栏上
    //   gradient     与动画顶部同色的半透明渐变 → 按钮像是浮在动画里
    //   none         不画条带，渐变直接铺到顶
    '+"#dshb-splash::before{content:\\"\\";position:absolute;left:0;right:0;top:0;height:40px;"',
    '+"background:' + TITLEBAR_TINT_DARK + '}"',
    '+"#dshb-splash[data-tb=\\"gradient\\"]::before{background:"',
    // 顶部已有底色，这里只叠一层极淡的渐变，让条带与下面的光晕自然衔接
    '+"linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,0))}"',
    '+"#dshb-splash[data-tb=\\"none\\"]::before{display:none}"',
    '+"#dshb-splash[data-out=\\"1\\"]{opacity:0;animation:none;transition:opacity .3s ease}"',
    '+"html[data-dshb-splash=\\"1\\"] body>:not(#dshb-splash){visibility:hidden}"',
    '+"#dshb-splash-card{display:flex;flex-direction:column;align-items:center;gap:18px}"',
    '+"#dshb-splash-mark{width:64px;height:64px;border-radius:18px;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(6,10,24,.38)}"',
    '+"#dshb-splash-mark svg{width:46px;height:34px;display:block}"',
    '+"#dshb-splash-word{font:600 20px/1.2 system-ui,-apple-system,\\"Segoe UI\\",sans-serif;letter-spacing:.06em;text-indent:.06em;color:#f2f5ff}"',
    '+"#dshb-splash-sub{font:400 12px/1.4 system-ui,-apple-system,\\"Segoe UI\\",sans-serif;color:rgba(233,237,247,.62);min-height:17px}"',
    '+"#dshb-splash-bar{width:196px;height:3px;border-radius:99px;background:rgba(233,237,247,.14);overflow:hidden}"',
    '+"#dshb-splash-bar>i{display:block;width:0%;height:100%;border-radius:99px;"',
    '+"background:linear-gradient(90deg,#4d6bfe,#7aa2ff 55%,#a9c2ff);transition:width .28s ease}"',
    '+"@media(prefers-reduced-motion:reduce){#dshb-splash{animation:none;opacity:1}}";',
    'var target=document.head||document.documentElement;',
    'target.appendChild(css);',
    'h.setAttribute("data-dshb-splash","1");',
    'var el=document.createElement("div");',
    'el.id="dshb-splash";',
    'el.setAttribute("data-tb",CFG.titlebar||"flat");',
    'var card=document.createElement("div");',
    'card.id="dshb-splash-card";',
    'if(CFG.splashLogo){',
    'var mk=document.createElement("div");',
    'mk.setAttribute("id","dshb-splash-mark");',
    'mk.setAttribute("aria-hidden","true");',
    'var fish=document.createElementNS("http://www.w3.org/2000/svg","svg");',
    'fish.setAttribute("viewBox","0 0 23.16 17.04");',
    'fish.innerHTML="<path fill=\\"#101319\\" d=\\"' + WHALE_PATH + '\\"/>";',
    'mk.appendChild(fish);',
    'card.appendChild(mk);',
    '}',
    'var word=document.createElement("div");',
    'word.id="dshb-splash-word";',
    'word.textContent="deepseek HARNESS";',
    'card.appendChild(word);',
    'var sub=document.createElement("div");',
    'sub.id="dshb-splash-sub";',
    'sub.textContent=CFG.splashText||"";',
    'card.appendChild(sub);',
    'if(CFG.splashBar){',
    'var bar=document.createElement("div");',
    'bar.id="dshb-splash-bar";',
    'var fill=document.createElement("i");',
    'bar.appendChild(fill);',
    'card.appendChild(bar);',
    '}',
    'el.appendChild(card);',
    'var mount=document.body||h;',
    'mount.appendChild(el);',
    'el.setAttribute("data-in","1");',
    '}catch(e){}',
    '})()',
  ])
}

// ---------------------------------------------------------------- 插件

export default {
  name: PACKAGE,

  /**
   * 刻意不写对象级 `inject`：那会把整个 apply 推迟到服务就绪之后，
   * 而注入行必须在桌面端启动收集之前进表。服务依赖用 `root.inject` 局部等待。
   */
  apply(root) {
    // ① 注入行：越早越好，且不依赖任何服务。
    //    顺序有意义：先设置 globalThis 配置（绘制前脚本要用），再铺首帧，最后引导本体。
    try {
      const dispose = root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          // 幂等：已经引导过本插件就不再重复推。
          for (const row of table) {
            if (row?.kind === 'script' && typeof row.text === 'string' && row.text.includes(ROUTES.widget)) return
            if (row?.kind === 'script-src' && row.src === ROUTES.widget) return
          }
          const prefs = readPrefs()
          table.push({ kind: 'script', placement: 'head', text: prePaintText(prefs) })
          table.push({ kind: 'script', placement: 'body', text: bootstrapText() })
        } catch (err) {
          /* 注入失败不应影响页面启动 */
        }
      })
      if (typeof dispose === 'function') root.effect(() => dispose)
    } catch (err) {
      /* 拿不到事件总线就静默降级：插件不生效，但不拖垮 profile */
    }

    // ② 其余逻辑：等 webServer（以及可选的 connection 信任栅栏）就绪。
    root.inject(['webServer'], (ctx) => {
      const disposers = []

      /**
       * 统一注册入口：若宿主提供 connection 信任栅栏，就把 Host/Origin 校验委托给它
       * （它内部还有一层浏览器鉴权）；栅栏抛异常一律按拒绝处理 —— 静默放行是最危险的失败模式。
       */
      function registerRoute(route) {
        const inner = route.handler
        return ctx.webServer.register(
          Object.assign({}, route, {
            handler: (req, res) => {
              const conn = ctx.get?.('connection')
              if (conn && typeof conn.requestRejection === 'function') {
                try {
                  const code = conn.requestRejection(req)
                  if (code !== undefined && code !== null && code !== false) {
                    res.writeHead(typeof code === 'number' ? code : 403, { 'Content-Type': 'text/plain; charset=utf-8' })
                    res.end('rejected')
                    return
                  }
                } catch (err) {
                  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
                  res.end('rejected')
                  return
                }
              }
              try {
                return inner(req, res)
              } catch (err) {
                try {
                  res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
                  res.end('handler error: ' + String(err?.message || err))
                } catch (err2) {
                  /* 连接可能已经断开 */
                }
              }
            },
          }),
        )
      }

      const NO_STORE = { 'Cache-Control': 'no-store' }
      const JS_HEADERS = { 'Content-Type': 'text/javascript; charset=utf-8', ...NO_STORE }
      const CSS_HEADERS = { 'Content-Type': 'text/css; charset=utf-8', ...NO_STORE }
      const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE }

      const readBody = (req, limit, done) => {
        let raw = ''
        req.on('data', (chunk) => {
          raw += chunk
          if (raw.length > limit) req.destroy()
        })
        req.on('end', () => done(raw))
      }

      /** 前端本体：每次请求都读盘，改完刷新页面即可生效。 */
      try {
        disposers.push(
          registerRoute({
            kind: 'exact',
            path: ROUTES.widget,
            handler: (req, res) => {
              try {
                const body = readFileSync(widgetPath)
                res.writeHead(200, { ...JS_HEADERS, 'Content-Length': String(body.length) })
                res.end(body)
              } catch (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('ui-beautify widget unavailable: ' + String(err?.message || err))
              }
            },
          }),
        )
      } catch (err) {
        console.error('[' + PACKAGE + '] 前端路由注册失败：' + String(err?.message || err))
      }

      /**
       * 标题栏自检页。
       *
       * 存在的理由：Windows 上那三个系统窗口按钮由 Electron 的 `titleBarOverlay` 绘制，
       * 网页只能通过 `--dsw-specific-sidebar-fill` 影响它的底色，肉眼在深色界面上
       * 很难判断到底生效没有。这个页面用与宿主 preload **完全相同的算法**把实际会
       * 交给主进程的颜色算出来，打开就能看到"生效 / 没生效"的明确结论。
       */
      try {
        disposers.push(
          registerRoute({
            kind: 'exact',
            path: ROUTES.titlebar,
            handler: (req, res) => {
              try {
                const body = readFileSync(titlebarProbePath)
                res.writeHead(200, {
                  'Content-Type': 'text/html; charset=utf-8',
                  ...NO_STORE,
                  'Content-Length': String(body.length),
                })
                res.end(body)
              } catch (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('titlebar probe unavailable: ' + String(err?.message || err))
              }
            },
          }),
        )
      } catch (err) {
        console.error('[' + PACKAGE + '] 标题栏自检页注册失败：' + String(err?.message || err))
      }

      /**
       * 「选择文件」图片上传：POST {name, data(base64)} → 存进插件目录，
       * 返回本插件自己的 http 地址。走 http 而不是 file:// 的原因：
       * Electron 默认 webSecurity 下，http 页面加载 file:// 子资源会被拦截；
       * 本路由同源，永远可用，而且图片已复制进来 —— 原文件移动/删除也不影响壁纸。
       */
      try {
        disposers.push(
          registerRoute({
            kind: 'exact',
            path: ROUTES.imageUpload,
            handler: (req, res) => {
              const method = String(req.method || 'GET').toUpperCase()
              if (method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE })
                res.end('method not allowed')
                return
              }
              readBody(req, IMAGE_MAX * 1.5, (raw) => {
                try {
                  const payload = JSON.parse(raw)
                  const buf = Buffer.from(String(payload.data || ''), 'base64')
                  if (buf.length === 0) {
                    res.writeHead(400, JSON_HEADERS)
                    res.end(JSON.stringify({ ok: false, error: 'empty image' }))
                    return
                  }
                  if (buf.length > IMAGE_MAX) {
                    res.writeHead(413, JSON_HEADERS)
                    res.end(JSON.stringify({ ok: false, error: 'image too large (max 16MB)' }))
                    return
                  }
                  const name = sanitizeImageName(payload.name)
                  // 时间戳保证每次上传都是新文件名 → 免缓存失效问题
                  const fileName = 'wall-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + name.slice(-40)
                  mkdirSync(IMAGES_DIR, { recursive: true })
                  writeFileSync(join(IMAGES_DIR, fileName), buf)
                  // 必须返回**相对路径**：桌面端页面跑在 dsh-app:// 自定义协议上，
                  // 若返回 http://127.0.0.1:19387/… 绝对地址，从页面发起的图片请求
                  // 会被宿主信任栅栏按 cross-site 403 拒掉（sec-fetch-site: cross-site），
                  // 连 <img> 都加载不了 —— 相对路径走自定义协议，与 prefs 请求同路，永远可用。
                  res.writeHead(200, JSON_HEADERS)
                  res.end(JSON.stringify({ ok: true, url: ROUTES.imagePrefix + '/' + fileName }))
                } catch (err) {
                  res.writeHead(400, JSON_HEADERS)
                  res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }))
                }
              })
            },
          }),
        )
      } catch (err) {
        console.error('[' + PACKAGE + '] 图片上传路由注册失败：' + String(err?.message || err))
      }

      /** 图片回读：GET /dsh-ui-miniskin/image/<文件名>。文件名白名单校验，杜绝路径穿越。 */
      try {
        disposers.push(
          registerRoute({
            kind: 'prefix',
            path: ROUTES.imagePrefix,
            handler: (req, res) => {
              try {
                const name = safeImageFileName(decodeURIComponent(String(req.url || '').split('/').pop()))
                if (!name) {
                  res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE })
                  res.end('bad name')
                  return
                }
                const extMatch = IMAGE_EXT_RE.exec(name)
                const body = readFileSync(join(IMAGES_DIR, name))
                res.writeHead(200, {
                  'Content-Type': (extMatch ? IMAGE_TYPES[extMatch[1].toLowerCase()] : 'image/jpeg') || 'image/jpeg',
                  // 文件名含时间戳、永不重名 → 可以放心长缓存
                  'Cache-Control': 'public, max-age=31536000, immutable',
                  'Content-Length': String(body.length),
                })
                res.end(body)
              } catch (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE })
                res.end('not found')
              }
            },
          }),
        )
      } catch (err) {
        console.error('[' + PACKAGE + '] 图片回读路由注册失败：' + String(err?.message || err))
      }

      /** 偏好：GET 读取，POST 合并写入（只收已知字段，写前清洗）。 */
      try {
        disposers.push(
          registerRoute({
            kind: 'exact',
            path: ROUTES.prefs,
            handler: (req, res) => {
              const method = String(req.method || 'GET').toUpperCase()
              if (method === 'GET') {
                res.writeHead(200, JSON_HEADERS)
                res.end(JSON.stringify({ ok: true, prefs: readPrefs(), presets: PRESETS, defaults: DEFAULTS }))
                return
              }
              if (method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE })
                res.end('method not allowed')
                return
              }
              readBody(req, 8192, (raw) => {
                try {
                  const patch = JSON.parse(raw || '{}')
                  const merged = Object.assign({}, readPrefs(), patch && typeof patch === 'object' ? patch : {})
                  const next = writePrefs(merged)
                  res.writeHead(200, JSON_HEADERS)
                  res.end(JSON.stringify({ ok: true, prefs: next }))
                } catch (err) {
                  res.writeHead(400, JSON_HEADERS)
                  res.end(JSON.stringify({ ok: false, error: 'bad request body' }))
                }
              })
            },
          }),
        )
      } catch (err) {
        console.error('[' + PACKAGE + '] 偏好路由注册失败：' + String(err?.message || err))
      }

      /**
       * 自报通道：界面自己把渲染后的实测事实送回来。
       *
       * 存在的理由：桌面壳关掉了远程调试（`--remote-debugging-port` 被 Electron 安全 fuse
       * 拒绝），外部既看不到界面像素，也无法在页面上执行 JS。只存内存、只留最近若干条。
       */
      const reportBuffer = []
      const REPORT_LIMIT = 200
      try {
        disposers.push(
          registerRoute({
            kind: 'exact',
            path: ROUTES.report,
            handler: (req, res) => {
              const method = String(req.method || 'GET').toUpperCase()
              if (method === 'GET') {
                res.writeHead(200, JSON_HEADERS)
                res.end(JSON.stringify({ ok: true, count: reportBuffer.length, reports: reportBuffer }))
                return
              }
              if (method !== 'POST') {
                res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', ...NO_STORE })
                res.end('method not allowed')
                return
              }
              // 探针会分批发节点，单批可能到几万字节；上限给足但仍有界
              readBody(req, 262144, (raw) => {
                try {
                  const entry = JSON.parse(raw || '{}')
                  entry.at = new Date().toISOString()
                  reportBuffer.push(entry)
                  while (reportBuffer.length > REPORT_LIMIT) reportBuffer.shift()
                  res.writeHead(200, JSON_HEADERS)
                  res.end(JSON.stringify({ ok: true, count: reportBuffer.length }))
                } catch (err) {
                  res.writeHead(400, JSON_HEADERS)
                  res.end(JSON.stringify({ ok: false, error: 'bad report body' }))
                }
              })
            },
          }),
        )
      } catch (err) {
        console.error('[' + PACKAGE + '] 自报路由注册失败：' + String(err?.message || err))
      }

      /** 体检：一眼看清插件是否真的挂上了。 */
      try {
        const startedAt = Date.now()
        disposers.push(
          registerRoute({
            kind: 'exact',
            path: ROUTES.health,
            handler: (req, res) => {
              res.writeHead(200, JSON_HEADERS)
              res.end(
                JSON.stringify({
                  ok: true,
                  plugin: PACKAGE,
                  version: VERSION,
                  node: process.version,
                  uptimeMs: Date.now() - startedAt,
                  widget: ROUTES.widget,
                  widgetExists: existsSync(widgetPath),
                  prefsFile: PREFS_FILE,
                  prefs: readPrefs(),
                  reports: reportBuffer.length,
                }),
              )
            },
          }),
        )
      } catch (err) {
        console.error('[' + PACKAGE + '] 体检路由注册失败：' + String(err?.message || err))
      }

      // 卸载时逐个释放路由，不留悬挂注册。
      ctx.effect(() => () => {
        for (const dispose of disposers) {
          if (typeof dispose === 'function') {
            try {
              dispose()
            } catch (err) {
              /* 释放失败不应阻断其他释放 */
            }
          }
        }
      })

      if (!existsSync(widgetPath)) console.warn('[' + PACKAGE + '] 前端本体缺失：' + widgetPath)
    })
  },
}
