/**
 * dsh-ui-miniskin —— 前端本体（浏览器侧，纯 JS，无依赖、无构建步骤）
 *
 * 由宿主注入的两行引导载入：`<head>` 里的「绘制前脚本」负责首帧与启动动画骨架，
 * 这里的本体负责：
 *
 * 1. **壁纸**：自建四个固定层（-101 不透明底色层 / -100 壁纸层 / -99 遮罩层 /
 *    -1 毛玻璃取色层），并把壁纸「内嵌」画到宿主自己的表面上（壁纸内嵌档），
 *    让宿主界面"透"出来，同时保证文字对比度。
 * 2. **启动动画**：接管首帧脚本铺下的骨架，等「宿主真的画出第一屏」再淡出。
 * 3. **设置**：不再自带面板 —— 设置集成在宿主设置面板里（见 ../client.js）。
 *
 * 硬规则（踩坑记录 A/C/G/H/J/K 节）：
 * - 自包含、幂等（重复载入撤掉上一个实例）、定时器/监听/Observer 都要回收；
 * - 不用 requestAnimationFrame 保证可见性（实测 opacity 会卡在过渡中间值）；
 * - 可热更新的样式全部由 applyStyle() 生成到 <style> 里，不写 element.style；
 * - 结构层不加 backdrop-filter（会创建包含块，把宿主 fixed/absolute 元素带偏）；
 * - 样式只覆盖**背景**令牌，绝不碰文字/描边令牌。
 */

;(function () {
  'use strict'

  var ROUTES = {
    prefs: '/dsh-ui-miniskin/prefs.json',
    report: '/dsh-ui-miniskin/report.json',
  }
  var WALL_ID = 'dsh-ui-miniskin-wall'
  var BACKDROP_ID = 'dsh-ui-miniskin-backdrop'
  var SCRIM_ID = 'dsh-ui-miniskin-scrim'
  var GLASS_ID = 'dsh-ui-miniskin-glass'
  var STYLE_ID = 'dsh-ui-miniskin-style'
  var SPLASH_ID = 'dshb-splash'

  // ------------------------------------------------------------ 工具

  var root = document.documentElement

  function safe(fn, fallback) {
    try {
      return fn()
    } catch (err) {
      return fallback
    }
  }

  function clamp(value, min, max, fallback) {
    if (typeof value !== 'number' || !isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.round(value)))
  }

  /**
   * 给渐变字符串做饱和度变换。
   *
   * 为什么需要它：默认「壁纸内嵌」档把壁纸直接画在宿主表面上，
   * 而 CSS 的 `filter:saturate()` 只能作用在元素整体（连文字一起变），
   * 不能只作用在 background-image 上 —— 所以把饱和度**烘进渐变的每个颜色值里**。
   * 对自定义图片做不到（位图无法改字符串），那一档饱和度不生效，属已知限制。
   */
  function saturateRgb(R, G, B, s) {
    var t = s / 100
    var r = (0.213 + 0.787 * t) * R + (0.715 - 0.715 * t) * G + (0.072 - 0.072 * t) * B
    var g = (0.213 - 0.213 * t) * R + (0.715 + 0.285 * t) * G + (0.072 - 0.072 * t) * B
    var b = (0.213 - 0.213 * t) * R + (0.715 - 0.715 * t) * G + (0.072 + 0.928 * t) * B
    return [
      Math.max(0, Math.min(255, Math.round(r))),
      Math.max(0, Math.min(255, Math.round(g))),
      Math.max(0, Math.min(255, Math.round(b))),
    ]
  }

  function saturateGradientCss(css, s) {
    if (!css || s === 100) return css
    // 先把 hex 颜色统一成 rgb()，再统一做变换
    var str = css.replace(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi, function (m, h) {
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
      var n = parseInt(h, 16)
      return 'rgb(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ')'
    })
    return str.replace(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/g, function (m, r, g, b, a) {
      var out = saturateRgb(Number(r), Number(g), Number(b), s)
      if (a === undefined) return 'rgb(' + out.join(',') + ')'
      return 'rgba(' + out[0] + ',' + out[1] + ',' + out[2] + ',' + a + ')'
    })
  }

  // ------------------------------------------------------------ 壁纸预设

  /**
   * 壁纸预设（服务端只校验名字，具体 CSS 在这里维护）。
   * 每个预设分 dark / light 两套：深色界面配深色底图、浅色界面配浅色底图。
   */
  var PRESETS = {
    aurora: {
      dark:
        'radial-gradient(900px 620px at 12% 8%, rgba(96,165,250,.68), transparent 60%),' +
        'radial-gradient(820px 560px at 88% 4%, rgba(167,139,250,.60), transparent 62%),' +
        'radial-gradient(900px 700px at 70% 96%, rgba(45,212,191,.44), transparent 60%),' +
        'linear-gradient(160deg, #070b18 0%, #101a33 52%, #060912 100%)',
      // 浅色变体颜色给足：太淡的粉彩 + 白色覆盖层 = 界面看起来还是纯白
      light:
        'radial-gradient(900px 620px at 12% 8%, rgba(96,165,250,.80), transparent 62%),' +
        'radial-gradient(820px 560px at 88% 4%, rgba(167,139,250,.72), transparent 64%),' +
        'radial-gradient(900px 700px at 70% 96%, rgba(45,212,191,.62), transparent 62%),' +
        'linear-gradient(160deg, #c3d4f8 0%, #bccbf6 52%, #c9e8e4 100%)',
    },
    nebula: {
      dark:
        'radial-gradient(720px 520px at 22% 12%, rgba(244,114,182,.42), transparent 60%),' +
        'radial-gradient(760px 560px at 82% 20%, rgba(129,140,248,.48), transparent 62%),' +
        'radial-gradient(900px 700px at 50% 100%, rgba(56,189,248,.28), transparent 60%),' +
        'linear-gradient(200deg, #0b0716 0%, #1b1030 55%, #07040f 100%)',
      light:
        'radial-gradient(720px 520px at 22% 12%, rgba(244,114,182,.60), transparent 62%),' +
        'radial-gradient(760px 560px at 82% 20%, rgba(129,140,248,.62), transparent 64%),' +
        'radial-gradient(900px 700px at 50% 100%, rgba(56,189,248,.44), transparent 62%),' +
        'linear-gradient(200deg, #f6d9ec 0%, #dcd2fa 55%, #cfe4fc 100%)',
    },
    dusk: {
      dark:
        'radial-gradient(760px 520px at 18% 10%, rgba(251,146,60,.40), transparent 60%),' +
        'radial-gradient(860px 600px at 84% 34%, rgba(244,63,94,.32), transparent 62%),' +
        'linear-gradient(170deg, #140a12 0%, #2a1424 50%, #0d070c 100%)',
      light:
        'radial-gradient(760px 520px at 18% 10%, rgba(251,146,60,.62), transparent 62%),' +
        'radial-gradient(860px 600px at 84% 34%, rgba(244,63,94,.44), transparent 64%),' +
        'linear-gradient(170deg, #fadfca 0%, #f6ccd6 50%, #f8d9de 100%)',
    },
    ocean: {
      dark:
        'radial-gradient(900px 640px at 26% 10%, rgba(56,189,248,.42), transparent 62%),' +
        'radial-gradient(920px 660px at 78% 90%, rgba(30,64,175,.46), transparent 62%),' +
        'linear-gradient(175deg, #04101c 0%, #082a45 55%, #03080f 100%)',
      light:
        'radial-gradient(900px 640px at 26% 10%, rgba(56,189,248,.60), transparent 64%),' +
        'radial-gradient(920px 660px at 78% 90%, rgba(59,130,246,.46), transparent 64%),' +
        'linear-gradient(175deg, #c6e4f8 0%, #c2dcf6 55%, #c9ecf2 100%)',
    },
    forest: {
      dark:
        'radial-gradient(820px 560px at 20% 12%, rgba(74,222,128,.32), transparent 60%),' +
        'radial-gradient(880px 620px at 84% 86%, rgba(20,83,45,.55), transparent 62%),' +
        'linear-gradient(168deg, #06120c 0%, #0d2a1c 55%, #040a07 100%)',
      light:
        'radial-gradient(820px 560px at 20% 12%, rgba(74,222,128,.52), transparent 62%),' +
        'radial-gradient(880px 620px at 84% 86%, rgba(16,185,129,.42), transparent 64%),' +
        'linear-gradient(168deg, #c9ecd6 0%, #bde5d0 55%, #d4f2e0 100%)',
    },
    sakura: {
      dark:
        'radial-gradient(780px 540px at 22% 10%, rgba(255,182,193,.50), transparent 62%),' +
        'radial-gradient(820px 600px at 80% 88%, rgba(196,132,252,.34), transparent 62%),' +
        'linear-gradient(172deg, #1a0f16 0%, #2c1a26 52%, #120a11 100%)',
      light:
        'radial-gradient(780px 540px at 22% 10%, rgba(255,182,193,.72), transparent 64%),' +
        'radial-gradient(820px 600px at 80% 88%, rgba(196,132,252,.48), transparent 64%),' +
        'linear-gradient(172deg, #fad7e2 0%, #f2d3ee 52%, #f0dcfa 100%)',
    },
    paper: {
      dark:
        'radial-gradient(900px 600px at 30% 6%, rgba(148,163,184,.20), transparent 62%),' +
        'linear-gradient(168deg, #0b0d12 0%, #14171f 60%, #0a0c11 100%)',
      light:
        'radial-gradient(900px 600px at 30% 6%, rgba(148,163,184,.38), transparent 64%),' +
        'linear-gradient(168deg, #e8edf6 0%, #dce2ee 60%, #eef1f7 100%)',
    },
    carbon: {
      dark:
        'repeating-linear-gradient(135deg, rgba(255,255,255,.030) 0 2px, transparent 2px 7px),' +
        'repeating-linear-gradient(45deg, rgba(255,255,255,.022) 0 2px, transparent 2px 9px),' +
        'linear-gradient(170deg, #08090d 0%, #12141b 60%, #07080c 100%)',
      light:
        'repeating-linear-gradient(135deg, rgba(15,23,42,.045) 0 2px, transparent 2px 7px),' +
        'repeating-linear-gradient(45deg, rgba(15,23,42,.032) 0 2px, transparent 2px 9px),' +
        'linear-gradient(170deg, #e6eaf2 0%, #d7dde8 60%, #eef1f6 100%)',
    },
    image: { dark: '', light: '' },
  }

  /** 取当前主题下的预设背景。 */
  function presetCss(name) {
    var item = PRESETS[name] || PRESETS.aurora
    var css = (isDark() ? item.dark : item.light) || item.dark || item.light
    // image 预设自己没有渐变：没填 URL / 图片加载失败时退回极光渐变兜底。
    // 否则 background-image 里的这一层是空串 → 整条声明失效 → 表面退回宿主纯白。
    if (!css) {
      var aur = PRESETS.aurora
      css = (isDark() ? aur.dark : aur.light) || aur.dark
    }
    return css
  }

  /** 宿主表面处理档位。 */
  var SURFACE_MODES = {
    embed: { label: '壁纸内嵌', alpha: 0.42, blur: false, embed: true },
    frost: { label: '毛玻璃', alpha: 0.66, blur: true },
    clear: { label: '全透明', alpha: 0, blur: true },
    tint: { label: '淡色调', alpha: 0.86, blur: false },
    off: { label: '保持原样', alpha: 1, blur: false },
  }

  /**
   * 宿主那些「成片的不透明表面」——壁纸要透出来，必须过这一关。
   * 实测（probe 自报）包括最外层布局框 `.BynINW_frame`（浅色下整块实色）、
   * 侧栏 `.BynINW_sidebarCol` / `._2H3hWW_root`、输入卡片 `.RlGAzG_card`。
   *
   * 选择器用「哈希段 + 语义名」前缀：纯哈希名跨构建会变，纯语义后缀会误伤。
   * `blurOk` 只给叶子卡片 —— backdrop-filter 会创建包含块，
   * 加在结构祖先上会把宿主自己的 fixed/absolute 元素重新定位（实测按钮下移压 Logo）。
   */
  var HOST_SURFACES = [
    { name: 'frame', sel: '[class*="BynINW_frame"]', token: '--dsw-alias-bg-base', alpha: 1.12, blurOk: false },
    { name: 'sidebar', sel: '[class*="BynINW_sidebarCol"]', token: '--dsw-specific-sidebar-fill', alpha: 0.92, blurOk: false },
    { name: 'sidebarRoot', sel: '[class*="_2H3hWW_root"]', token: '--dsw-specific-sidebar-fill', alpha: 0.92, blurOk: false },
    // 浅色主题下这两个是纯白实色（rgb(255,255,255)），把整个对话区盖住 —— 必须列进来
    { name: 'centerCol', sel: '[class*="BynINW_centerCol"]', token: '--dsw-alias-bg-base', alpha: 1.0, blurOk: false },
    { name: 'centerRoot', sel: '[class*="Dc7zOa_root"]', token: '--dsw-alias-bg-base', alpha: 1.0, blurOk: false },
    { name: 'composer', sel: '[class*="RlGAzG_card"]', token: '--dsw-alias-bg-layer-2', alpha: 0.96, blurOk: true },
    // 注意（回滚记录）：曾把 `Dc7zOa_composerSeat`（输入框座位区）也加进来当弹层底衬，
    // 结果它在对话区下缘多铺了一层罩层，实测亮度比周围高 9 → 明显断层。
    // 弹层真正的修法是「菜单底色令牌调厚 + 别在容器上制造 backdrop root」，不是铺座位区。
    // 设置弹层（Ctrl+, 打开的那个）：wCInkW_panel 用 var(--dsw-alias-bg-layer-2)，
    // 浅色主题下是纯白卡片，遮住壁纸。弹层容器是 fixed inset:0，
    // background-attachment:fixed 依然按视口对齐，面板会像"从壁纸上裁下来"的一块。
    { name: 'settingsPanel', sel: '[class*="wCInkW_panel"]', token: '--dsw-alias-bg-layer-2', alpha: 0.96, blurOk: false },
  ]

  // ------------------------------------------------------------ 主题

  /**
   * 当前界面是深色还是浅色。判据是**宿主自己的信号**：
   * `<body data-ds-dark-theme>` 存在即深色（宿主主题来源是 system，跟随操作系统）。
   * 插件偏好里的 mode 只用来「强制壁纸走哪一套配色」。
   */
  function hostDark() {
    return safe(function () {
      return document.body ? document.body.hasAttribute('data-ds-dark-theme') : false
    }, false)
  }

  function isDark() {
    if (mode === 'dark') return true
    if (mode === 'light') return false
    return hostDark()
  }

  /** 毛玻璃层的底色（浅色用白、深色用近黑）。 */
  function glassBase(multiplier) {
    return isDark()
      ? 'rgba(10,12,18,calc(var(--dshb-a) * ' + multiplier + '))'
      : 'rgba(255,255,255,calc(var(--dshb-a) * ' + multiplier + '))'
  }

  /**
   * 表面底色。浅色主题下宿主的次要文字本身就是浅灰，压在彩色壁纸上对比度不够，
   * 所以浅色档给更高的白度；深色档可以更透，让壁纸更显。
   */
  function surfaceColor(alpha) {
    var lightBoost = 1.45
    return isDark()
      ? 'rgba(10,12,18,calc(' + alpha + '))'
      : 'rgba(255,255,255,calc(' + alpha + ' * ' + lightBoost + '))'
  }

  // ------------------------------------------------------------ 状态

  /** 偏好：以宿主注入的绘制前配置为准，缺失时用内置默认值。 */
  var CFG = (function () {
    var injected = globalThis.__DSH_UI_MINISKIN__
    return injected && typeof injected === 'object' ? injected : {}
  })()

  var dim = typeof CFG.dim === 'number' ? CFG.dim : 22
  var blur = typeof CFG.blur === 'number' ? CFG.blur : 0
  var saturate = typeof CFG.saturate === 'number' ? CFG.saturate : 100
  var transparency = typeof CFG.transparency === 'number' ? CFG.transparency : 44
  var preset = typeof CFG.preset === 'string' && PRESETS[CFG.preset] ? CFG.preset : 'aurora'
  var mode = CFG.mode === 'light' || CFG.mode === 'dark' ? CFG.mode : 'auto'
  // 「界面处理」档位已从设置面板移除，固定用最稳的壁纸内嵌。
  var surface = 'embed'
  var wallpaperOn = CFG.wallpaper !== false
  var vignette = CFG.vignette !== false

  /**
   * 把本插件自己的图片地址规范成**相对路径**。
   * 桌面端页面跑在 dsh-app:// 自定义协议上：历史版本存的是
   * http://127.0.0.1:19387/… 绝对地址，从 dsh-app:// 页面发起的图片请求
   * 会被宿主信任栅栏按 cross-site 403 拒掉（连 <img> 都加载不了，实测）。
   * 相对路径走自定义协议、与 prefs 请求同路，永远可用。
   */
  function normalizeImageUrl(u) {
    if (typeof u !== 'string' || !u) return u
    var i = u.indexOf('/dsh-ui-miniskin/image/')
    if (i > 0) return u.slice(i)
    // 兼容旧包名（dsh-ui-beautify）存下的地址：把路径前缀改成新包名
    var j = u.indexOf('/dsh-ui-beautify/image/')
    if (j > 0) return '/dsh-ui-miniskin' + u.slice(j + '/dsh-ui-beautify'.length)
    return u
  }

  var image = normalizeImageUrl(typeof CFG.image === 'string' ? CFG.image : '')
  var imageFailed = false

  /**
   * 自定义图片的平均亮度（0-255），null = 还没测出来。
   *
   * 为什么需要它：预设壁纸分深浅两套，浅色界面永远配浅色变体，所以文字一定读得清。
   * **自定义图片没有主题变体** —— 用户在浅色界面选一张深色照片时，
   * 深色文字压在深色照片上就看不清了。量出亮度后按图片决定界面文字颜色：
   * 深图 → 套上宿主的深色主题（浅字），亮图 → 摘下（深字）。
   * 图片本身保持清晰，罩层不加厚 —— 之前的"半透明白膜"方案已废弃。
   * 预设路径完全不读取这个值，所以预设观感一行不变。
   */
  var imageLuma = null
  var imageLumaUrl = ''
  var lumaMeasuring = false

  /** 量图片平均亮度（缩到 12×12 采样，同源图片才能读像素）。 */
  function measureImageLuma(url) {
    if (!url || lumaMeasuring) return
    lumaMeasuring = true
    imageLumaUrl = url
    var probe = new Image()
    probe.onload = function () {
      lumaMeasuring = false
      try {
        var c = document.createElement('canvas')
        var size = 12
        c.width = size
        c.height = size
        var g = c.getContext('2d')
        g.drawImage(probe, 0, 0, size, size)
        var px = g.getImageData(0, 0, size, size).data
        var sum = 0
        var n = size * size
        for (var i = 0; i < n; i++) {
          sum += 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]
        }
        var luma = sum / n
        // 亮度变化很小就不重绘，避免无谓抖动
        if (imageLuma === null || Math.abs(luma - imageLuma) > 6) {
          imageLuma = luma
          report('image-luma', { luma: Math.round(luma), url: String(url).slice(0, 80) })
          paintWallpaper()
        }
      } catch (err) {
        // 读不到像素（跨域污染等）→ 保持 null，主题不动
        imageLuma = null
      }
    }
    probe.onerror = function () {
      lumaMeasuring = false
      imageLuma = null
    }
    probe.src = url
  }

  /** 图片模式下的主题翻转记录：null=未动过宿主主题；true/false=我们翻转后的目标值。 */
  var themeFlippedByImage = null
  var themePreFlipDark = null
  var lastFlipAt = 0
  var imageThemeRecheck = null

  /**
   * 按图片亮度翻转界面主题（只改 body 的 data-ds-dark-theme，不动任何 CSS 令牌）：
   * 深图 → 加属性（宿主的整套深色主题生效：浅色文字、深色控件，全都自动跟上）；
   * 亮图 → 摘属性（宿主浅色主题）。
   * 阈值 128。图片亮度还没测出来时不动主题。
   *
   * 注意（实测教训）：**每次都对比属性真值，而不是信自己的翻转记录** ——
   * 宿主在启动早期会执行自己的主题同步，把我们刚挂上的属性摘回去
   * （自报时序：image-theme-flip → theme-changed{dark:true} → theme-changed{dark:false}，
   * 症状就是"启动后字还是黑的，切一下预设才变白"）。
   * 因此本函数被观察器/延时任务再次调用时必须能纠正回来。
   */
  function applyImageTheme() {
    var active = preset === 'image' && image && !imageFailed
    if (!active || imageLuma === null) return
    var body = document.body
    if (!body) return
    var shouldDark = imageLuma < 128
    var has = body.hasAttribute('data-ds-dark-theme')
    if (has === shouldDark) return
    // 防止与宿主对打时高频抖动（真正需要纠正时 1.5s 后的定时复查会再试）
    var nowMs = Date.now()
    if (nowMs - lastFlipAt < 250) return
    lastFlipAt = nowMs
    if (themeFlippedByImage === null) themePreFlipDark = has
    themeFlippedByImage = shouldDark
    if (shouldDark) body.setAttribute('data-ds-dark-theme', '')
    else body.removeAttribute('data-ds-dark-theme')
    report('image-theme-flip', { luma: Math.round(imageLuma), toDark: shouldDark })
  }

  /** 离开图片模式时，把宿主主题还原成我们翻转之前的状态。 */
  function restoreOwnTheme() {
    if (themeFlippedByImage === null) return
    var body = document.body
    if (!body) return
    if (themePreFlipDark) body.setAttribute('data-ds-dark-theme', '')
    else body.removeAttribute('data-ds-dark-theme')
    themeFlippedByImage = null
    themePreFlipDark = null
    report('image-theme-restored', {})
  }
  var splashMs = typeof CFG.splashMs === 'number' ? CFG.splashMs : 1100
  var splashText = typeof CFG.splashText === 'string' ? CFG.splashText : ''
  var splashLogo = CFG.splashLogo !== false
  var splashBar = CFG.splashBar !== false
  var splashOn = CFG.splash !== false
  /** 日常标题栏是否融入壁纸（透明化，让右上角系统按钮浮在皮肤上）。 */
  var titlebarBlend = CFG.titlebarBlend === true

  // ------------------------------------------------------------ 自报

  var REPORTED = {}

  /** 自报：把渲染后的实测事实送回宿主。桌面壳关掉了远程调试，这是外部唯一能拿到的渲染真值。 */
  function report(event, extra) {
    safe(function () {
      var payload = { event: event, version: CFG.version || '' }
      if (extra) {
        for (var key in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key]
        }
      }
      payload.doc = {
        href: String(location.href).slice(0, 160),
        title: String(document.title || '').slice(0, 80),
        topFrame: window.self === window.top,
        visibility: document.visibilityState,
        dpr: window.devicePixelRatio,
      }
      payload.theme = {
        dark: isDark(),
        mode: mode,
        attr: String(root.getAttribute('data-ds-dark-theme') !== null ? 'data-ds-dark-theme' : ''),
        htmlClass: String(root.className || '').slice(0, 80),
      }
      payload.prefs = {
        wallpaper: wallpaperOn,
        preset: preset,
        mode: mode,
        dim: dim,
        transparency: transparency,
        blur: blur,
        surface: surface,
        image: image.slice(0, 120),
      }
      fetch(ROUTES.report, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // 注意：不能 keepalive —— Chromium 对 keepalive 请求有 ~64KB 上限，
        // DOM 探针的 meta 报文可能超过，超限的请求会**静默失败**（fetch 不抛错），
        // 表现为"第一次能报、之后再也没报过"。这里改成普通请求。
      }).catch(function () {})
    })
  }

  function reportOnce(key, event, extra) {
    if (REPORTED[key]) return
    REPORTED[key] = true
    report(event, extra)
  }

  // ------------------------------------------------------------ 样式

  /**
   * 「宿主表面透明化」档（frost / clear / tint）的规则。
   * 同时做两件事：① 覆盖背景令牌；② 直接覆盖 background-color。
   * 结构层不加 backdrop-filter（blurOk:false），叶子卡片才允许。
   */
  function surfaceCss() {
    var spec = SURFACE_MODES[surface] || SURFACE_MODES.embed
    var rules = []
    // off 与 embed 都不走这套透明化：off 完全不动宿主；
    // embed 由 embedWallCss 接手（把壁纸画在表面上），
    // 若这里也发规则，它的 `backdrop-filter:none !important` 会压掉 embed 的模糊。
    if (surface === 'off' || spec.embed === true) return ''

    for (var i = 0; i < HOST_SURFACES.length; i++) {
      var s = HOST_SURFACES[i]
      var base = 'html[data-dshb-wall="1"] body ' + s.sel
      var factor = (typeof s.alpha === 'number' ? s.alpha : 1)
      // calc() 里的乘法必须写 `var(--a) * 1.2`；直接写 `2 var(--a)` 是无效值、静默失效
      var alpha = spec.alpha === 0 ? '0' : 'var(--dshb-surface-a) * ' + factor
      rules.push(base + '{' + s.token + ':transparent !important;' +
        'background-color:' + surfaceColor(alpha) + ' !important}')
      if (spec.blur && s.blurOk) {
        rules.push(base + '{backdrop-filter:blur(var(--dshb-blur)) saturate(1.06);' +
          '-webkit-backdrop-filter:blur(var(--dshb-blur)) saturate(1.06)}')
      } else {
        // 结构层**不加** backdrop-filter：它会创建包含块，
        // 把宿主自己的 fixed/absolute 元素重新定位（实测侧栏折叠按钮下移压住 Logo）
        rules.push(base + '{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}')
      }
    }
    return rules.join('')
  }

  /**
   * 「壁纸内嵌」档：把壁纸画在宿主自己的表面上。
   * 宿主元素保持不透明（不动层叠、不动布局），底色带 α 并叠上壁纸，
   * 颜色与壁纸的叠加由浏览器自己完成；background-attachment:fixed 让各表面
   * 共享同一块视口对齐的底图。
   *
   * 层序（background-image 第一个层在最上面）：
   *   ① 遮罩深度层（dim，压暗整张合成结果 —— 这就是「遮罩深度」滑块在内嵌档的作用点）
   *   ② 半透明底色层（transparency，越大壁纸越透）
   *   ③ 壁纸图（已是按 saturate 烘好的字符串）
   *
   * 毛玻璃模糊：只给 blurOk 的叶子卡片加 backdrop-filter（它会创建包含块，
   * 加在结构层上会把宿主 fixed/absolute 元素重新定位 —— 实测侧栏按钮被顶下去）。
   * body 也要自己画壁纸：它是文档画布的绘制者，画布透明时露出来的是
   * Electron 窗口的深色底，而不是宿主的界面色。
   */
  function embedWallCss(wallImage, useImage) {
    var spec = SURFACE_MODES[surface] || SURFACE_MODES.embed
    if (spec.embed !== true || !wallpaperOn) return ''

    // 每张表面的层栈（第一个层在最上面）：
    //   ① 暗角（vignette，可选）
    //   ② 遮罩深度层（dim）
    //   ③ 半透明底色层（transparency）
    //   ④ 壁纸（已按 saturate 烘好）
    // 浅色主题的三点修正（实测用户是浅色系统 + 浅色壁纸 → 界面像纯白）：
    //   - 白色覆盖层减半并带一点蓝调，否则壁纸全被洗白；
    //   - dim 层压到原来的六成，否则整片发灰；
    //   - 壁纸本身的浅色变体也加重了颜色（见 PRESETS）。
    /**
     * 生成一张表面的背景层栈。
     * @param factor 该表面的罩层倍率（侧栏 0.92、主区 1.0 之类）
     * @param withWall 是否画壁纸副本（磨砂档不画，让 backdrop 模糊成为主体）
     * @param kind 'normal' | 'card' | 'cardFrost'
     *
     * 可读性下限（本轮重点）：罩层 α 随「界面透明」变薄，但**必须有地板**，
     * 否则用户把透明度拉满时整个界面裸奔、文字糊在壁纸上（实测被投诉）。
     * 输入卡片再高一些 —— 它是打字的地方，可读性最要紧。
     */
    function stack(factor, withWall, kind) {
      var layers = []
      if (vignette) {
        layers.push(
          isDark()
            ? 'radial-gradient(120% 90% at 50% 42%, rgba(0,0,0,0) 55%, rgba(0,0,0,.32) 100%)'
            : 'radial-gradient(120% 90% at 50% 42%, rgba(0,0,0,0) 55%, rgba(24,34,60,.24) 100%)',
        )
      }
      // 自定义图片：罩层保持**极薄**（照片清晰，不做"白膜"）。
      // 可读性不靠罩层，靠「文字颜色跟随图片亮度」（applyImageTheme 翻转宿主主题）。
      // 亮度还没测出来前用 0.5 的保守罩层兜一下，测完立即变薄并翻转主题。
      var imgDim = useImage ? 0.5 : 1
      var dimLayer = isDark()
        ? 'rgba(6,10,20,' + (dim / 100) * imgDim + ')'
        : 'rgba(26,34,54,' + (dim / 100) * 0.6 * imgDim + ')'
      layers.push('linear-gradient(' + dimLayer + ',' + dimLayer + ')')

      // 罩层 α：语义是「界面透明越大 = 罩层越薄」，所以用 (1 - transparency)。
      // 地板值保证任何透明度下都还读得清字。
      var t = 'var(--dshb-transparency)'
      var alphaExpr
      if (kind === 'frost') {
        // 磨砂卡片（只有用户把「毛玻璃模糊」调大时才走这条）：
        // 一块独立面板 + backdrop 模糊 —— 它会和周围形成分界，这是"磨砂玻璃"本身的代价。
        alphaExpr = 'calc(' + (isDark() ? '0.88' : '0.86') + ' - ' + t + ' * 0.26)'
      } else if (useImage) {
        // 自定义图片档：极薄罩层，图片几乎原样呈现。
        // 亮度未知时 0.5（先保证能读），测完 0.16（照片清晰 + 主题已翻转，字仍读得清）。
        var imgBase = imageLuma === null ? 0.5 : 0.16
        alphaExpr =
          'clamp(0.10, ' + imgBase.toFixed(3) +
          ' * (1 - ' + t + ' * 0.35) * ' + factor + ', 1)'
      } else {
        // 普通表面（含所有预设壁纸）：罩层随「界面透明」变薄，但有地板，
        // 避免拉满时界面裸奔、文字糊在壁纸上。
        alphaExpr =
          'clamp(' + (isDark() ? '0.34' : '0.22') + ', (1 - ' + t + ') * ' +
          (isDark() ? '0.79' : '0.43') + ' * ' + factor + ', 1)'
      }
      var color = isDark()
        ? 'rgba(10,12,18,' + alphaExpr + ')'
        : 'rgba(226,236,252,' + alphaExpr + ')'
      layers.push('linear-gradient(' + color + ',' + color + ')')
      // 磨砂档不画壁纸副本：让 backdrop-filter 的模糊输出成为主体。
      layers.push(withWall === false ? 'linear-gradient(rgba(0,0,0,0),rgba(0,0,0,0))' : wallImage)

      var n = layers.length
      var list = function (value, last) {
        var arr = []
        for (var i = 0; i < n; i++) arr.push(i === n - 1 ? last : value)
        return arr.join(',')
      }
      return (
        'background-image:' + layers.join(',') + '!important;' +
        'background-size:' + list('auto', 'cover') + '!important;' +
        'background-position:' + list('center', 'center') + '!important;' +
        'background-repeat:' + list('no-repeat', 'no-repeat') + '!important;' +
        // 所有层都用 fixed：不只壁纸，暗角/遮罩/罩层也要按**视口**定位。
        // 用 scroll 时每张表面各自按自身尺寸画一遍暗角（渐变层的定位区=元素盒子），
        // 相邻表面一大一小就会在交界处出现亮度台阶 —— 实测"断层"的主要来源。
        'background-attachment:fixed!important;' +
        'background-origin:' + list('padding-box', 'padding-box') + '!important;' +
        'background-clip:' + list('border-box', 'border-box') + '!important;'
      )
    }

    var rules = []
    for (var i = 0; i < HOST_SURFACES.length; i++) {
      var s = HOST_SURFACES[i]
      // 磨砂档：blur 打开时，卡片去掉自己的壁纸副本 + 用半透明面板，
      // 让背后内容透出来被 backdrop-filter 模糊（这就是"毛玻璃"）。
      var frost = s.blurOk === true && blur > 1
      // 关键：卡片**只在磨砂档才写 backdrop-filter**。
      // 任何非 none 的 backdrop-filter 都会创建 backdrop root，
      // 其内部元素（比如宿主菜单靠 ::before 的 blur(40px) 磨砂）就再也采样不到
      // 页面背后的内容 —— 菜单会退化成半透明白、文字直接透出来（实测被投诉）。
      // blur=0 时写 blur(0px) 依然算非 none，同样会踩这个坑。
      rules.push(
        'html[data-dshb-wall="1"] body ' + s.sel + '{' +
          stack(
            typeof s.alpha === 'number' ? s.alpha : 1,
            !frost,
            frost ? 'frost' : 'normal',
          ) +
          (frost
            ? 'backdrop-filter:blur(var(--dshb-blur)) saturate(1.15);' +
              '-webkit-backdrop-filter:blur(var(--dshb-blur)) saturate(1.15)}'
            : 'backdrop-filter:none!important;-webkit-backdrop-filter:none!important}'),
      )
    }
    rules.push(
      'html[data-dshb-wall="1"] body{' + stack(1) + 'background-color:transparent!important}',
    )
    return rules.join('')
  }

  /** 把全部样式生成到 `<style>`（主题相关的值在这里算好写进去）。 */
  function applyStyle(vars) {
    var embed = (SURFACE_MODES[surface] || SURFACE_MODES.embed).embed === true
    var css = [
      // ---- 底色层（-101）：永远铺满视口的不透明底。
      // 这一层是"文档画布"的地基：画布透明时露出来的是 Electron 窗口的深色底。
      // 兜底必须**不透明**（踩坑记录 C5）。
      '#' + BACKDROP_ID + '{position:fixed;inset:0;z-index:-101;pointer-events:none;',
      'background:' + (isDark() ? '#0a0c12' : '#f4f6fa') + '}',
      'html[data-dshb-wall="1"] #' + BACKDROP_ID + '{',
      'background-image:linear-gradient(rgba(4,7,14,' + (dim / 100) + '),rgba(4,7,14,' + (dim / 100) + ')),' +
        (vars.wallImage || 'none') + ';',
      'background-size:auto,cover;background-position:center,center;',
      'background-repeat:no-repeat,no-repeat;background-attachment:scroll,fixed}',

      // ---- 壁纸层（-100）与遮罩层（-99）
      '#' + WALL_ID + '{position:fixed;inset:0;z-index:-100;background-repeat:no-repeat;',
      'background-size:cover;background-position:center;pointer-events:none;',
      'filter:' + (vars.wallFilter || 'none') + '}',
      '#' + SCRIM_ID + '{position:fixed;inset:0;z-index:-99;pointer-events:none;',
      'background:rgba(6,10,20,' + (dim / 100) + ')}',
      'html[data-dshb-vignette="1"] #' + SCRIM_ID + '{',
      'background:radial-gradient(120% 90% at 50% 42%, rgba(0,0,0,0) 42%, rgba(0,0,0,' + (dim / 100 + 0.22) + ') 100%),',
      'rgba(6,10,20,' + (dim / 100) + ')}',
      // 浅色主题的遮罩用冷灰而不是纯黑：黑纱会把浅色界面压成"脏灰"
      'html[data-dshb-dark="0"] #' + SCRIM_ID + '{background:rgba(22,30,50,' + (dim / 100 + 0.12) + ')}',

      // ---- 毛玻璃取色层（-1）
      '#' + GLASS_ID + '{position:fixed;inset:0;z-index:-1;pointer-events:none;',
      '--dshb-a:var(--dshb-transparency, .45);',
      'background:' + glassBase(isDark() ? 0.60 : 0.42) + ';',
      'backdrop-filter:blur(var(--dshb-blur, 14px)) saturate(1.08);',
      '-webkit-backdrop-filter:blur(var(--dshb-blur, 14px)) saturate(1.08)}',

      // ---- 宿主表面透明化：覆盖主题令牌（不改文字/描边令牌）
      // 内嵌档不做这套覆盖（它把壁纸画在宿主表面上，不需要动层叠）。
      // 只在 data-dshb-wall="1" 时生效；壁纸关闭时宿主必须保持原样。
      embed
        ? ''
        : 'html[data-dshb-wall="1"] body{--dsw-alias-bg-base:transparent;' +
          '--dsw-alias-bg-layer-1:transparent;--dsw-alias-bg-layer-2:transparent;' +
          '--dsw-alias-bg-layer-3:transparent;--dsw-alias-bg-overlay:transparent !important;' +
          'background-color:transparent !important}' +
          // 深色主题的令牌定义在 body[data-ds-dark-theme]（特异性更高），必须同样特异性再写一遍
          'html[data-dshb-wall="1"] body[data-ds-dark-theme]{--dsw-alias-bg-base:transparent;' +
          '--dsw-alias-bg-layer-1:transparent;--dsw-alias-bg-layer-2:transparent;' +
          '--dsw-alias-bg-layer-3:transparent;--dsw-alias-bg-overlay:transparent}',
      // 宿主首帧背景变量也一并放掉
      'html[data-dshb-wall="1"]{--dsh-boot-bg:transparent}',
      surfaceCss(),
      embedWallCss(vars.wallImage || 'none', vars.useImage === true),

      // ---- 日常标题栏融入壁纸：把标题栏底色钉成透明。
      // 宿主 preload 从 --dsw-specific-sidebar-fill 读颜色经 IPC 交给主进程
      // （setTitleBarOverlay），透明值会让那 40px 露出下面的壁纸，
      // 右上角系统按钮直接浮在皮肤上。属性由「标题栏融入壁纸」开关控制，
      // 改开关 → paintWallpaper 重建样式 → preload 观察到变化 → 标题栏实时更新。
      // 注意：两个属性选择器都在 html 上（属性就打在 html 上）——
      // 写错成 body[data-dshb-blend] 就会永远匹配不上（实测踩过）。
      'html[data-dshb-wall="1"][data-dshb-blend="1"] body{--dsw-specific-sidebar-fill:transparent!important}',

      // ---- 宿主菜单/弹层的底色令牌调厚。
      // 宿主菜单（加号上拉栏、下拉菜单等）默认是 `#f8f9fa94`（58% 白）+ blur(40px)
      // 的磨砂设计 —— 这套设计假设背后是纯色界面。壁纸铺上后 58% 太薄，
      // 背后图案会透上来。调成 94% 后依旧保留磨砂边角，但文字稳了。
      wallpaperOn
        ? 'html[data-dshb-wall="1"] body{--dsw-specific-menu:rgba(248,249,250,0.94)!important}' +
          'html[data-dshb-wall="1"] body[data-ds-dark-theme]{--dsw-specific-menu:rgba(48,49,54,0.94)!important}'
        : '',

      // ---- 去掉宿主的「白色渐隐条」（浅色主题下它们渐隐到纯白，就是用户看到的白条）：
      // ① 侧栏工作区树底部的 _9lTDKa_fade（压在 ID/头像上方）→ 直接移除。
      // ② 对话区底部的 Dc7zOa_composerSeat 渐隐（透明 → 表面白）→ 清掉背景图。
      //    （曾把座位区铺上壁纸当弹层底衬，结果多出一层罩层、下缘出现断层，已回滚。）
      wallpaperOn
        ? 'html[data-dshb-wall="1"] body [class*="_9lTDKa_fade"]{display:none!important}' +
          'html[data-dshb-wall="1"] body [class*="Dc7zOa_composerSeat"]{background:none!important}' +
          // 对话区左上角在 Windows 上是 16px 圆弧（--dsh-windows-content-radius），
          // 而侧栏与标题栏都是直角 —— 壁纸连续铺开时，圆弧会在三者交界处
          // 掏出一个"缺口"，看起来就是工作区直角、对话区圆弧的不协调感。
          // 壁纸打开时把对话区改回直角，三个区域对齐。
          'html[data-dshb-wall="1"] body [class*="BynINW_centerCol"]{border-radius:0!important;corner-shape:auto!important}' +
          // ---- 加号上拉栏（宿主菜单 v1kfCW_panel）：底色是伪元素 + 令牌，
          // 宿主默认 #f8f9fa94（58% 白）+ blur(40px)。壁纸背景下 58% 太薄，
          // 背后图案会透上来。这里直接把伪元素底色钉厚（保留圆角与磨砂感）。
          'html[data-dshb-wall="1"] body [class*="v1kfCW_panel"]::before{background:' +
          (isDark() ? 'rgba(48,49,54,.96)' : 'rgba(248,249,250,.96)') +
          '!important;backdrop-filter:blur(40px) saturate(150%)!important}'
        : '',
    ].join('')

    var el = document.getElementById(STYLE_ID)
    if (!el) {
      el = document.createElement('style')
      el.id = STYLE_ID
      ;(document.head || root).appendChild(el)
    }
    el.textContent = css
  }

  // ------------------------------------------------------------ 壁纸

  function ensureNode(id, tag) {
    var el = document.getElementById(id)
    if (!el) {
      el = document.createElement(tag || 'div')
      el.id = id
      ;(document.body || root).appendChild(el)
    }
    return el
  }

  /** 把当前偏好刷到 DOM 上（切预设/拖滑块都走这里）。 */
  function paintWallpaper() {
    var backdrop = ensureNode(BACKDROP_ID)
    var wall = ensureNode(WALL_ID)
    var scrim = ensureNode(SCRIM_ID)
    var glass = ensureNode(GLASS_ID)

    // 饱和度烘进渐变字符串：内嵌档把壁纸画在宿主表面上，filter 只能作用在元素整体
    // （连文字一起变），所以不能靠 filter 给表面上的背景调饱和度。
    var presetCssValue = saturateGradientCss(presetCss(preset), saturate)
    var useImage = preset === 'image' && image && !imageFailed

    // 自定义图片：量一次平均亮度（决定文字颜色），量完会自己重绘一次。
    // 带 URL 缓存，避免每次重绘都去解码图片。
    if (useImage && imageLumaUrl !== image) measureImageLuma(image)

    // 图片模式：按图片亮度翻转宿主主题（深图 → 深色主题浅字，亮图 → 浅色主题深字）；
    // 非图片模式：把主题还原成翻转前的宿主原样。
    if (useImage) {
      applyImageTheme()
      // 启动早期宿主的主题同步可能把我们的翻转盖回去（实测）。
      // 1.5s 后复查一次：属性被摘了就再挂回去。此后宿主的同步早已结束，翻转稳定。
      if (imageThemeRecheck !== null) clearTimeout(imageThemeRecheck)
      imageThemeRecheck = setTimeout(function () {
        applyImageTheme()
      }, 1500)
    } else {
      if (imageThemeRecheck !== null) {
        clearTimeout(imageThemeRecheck)
        imageThemeRecheck = null
      }
      restoreOwnTheme()
    }

    // 图片层：预设 CSS 作为「加载中/失败」时的底，图片加载成功后再盖上去。
    // 自定义图片是位图、无法按字符串烘饱和度，所以只有图片档才用 filter 调饱和。
    wall.style.backgroundImage = useImage
      ? 'linear-gradient(rgba(0,0,0,' + Math.min(0.5, dim / 100) + '),rgba(0,0,0,' + Math.min(0.5, dim / 100) + ')), url("' + image.replace(/"/g, '%22') + '")'
      : presetCssValue

    // 「壁纸内嵌」档要把同一张底图画到宿主表面上，所以最终背景值算好后
    // 交给 applyStyle 写进样式表 —— 由样式表统一持有，开关/换档时才不会漏改。
    var wallImage = useImage ? 'url("' + image.replace(/["\\]/g, '') + '")' : presetCssValue
    var wallFilter = useImage ? 'saturate(' + saturate + '%)' : 'none'
    wall.style.filter = wallFilter

    applyStyle({
      dim: dim,
      saturate: saturate,
      transparency: transparency,
      blur: blur,
      wallImage: wallImage,
      wallFilter: wallFilter,
      useImage: useImage,
    })

    root.setAttribute('data-dshb-dark', isDark() ? '1' : '0')
    root.setAttribute('data-dshb-wall', wallpaperOn ? '1' : '0')
    root.setAttribute('data-dshb-vignette', vignette ? '1' : '0')
    root.setAttribute('data-dshb-blend', titlebarBlend ? '1' : '0')
    root.style.setProperty('--dshb-transparency', String(transparency / 100))
    root.style.setProperty('--dshb-blur', blur + 'px')
    var surfaceSpec = SURFACE_MODES[surface] || SURFACE_MODES.embed
    root.style.setProperty('--dshb-surface-a', String(surfaceSpec.alpha))

    var hidden = !wallpaperOn
    wall.style.display = hidden ? 'none' : 'block'
    scrim.style.display = hidden ? 'none' : 'block'
    glass.style.display = hidden ? 'none' : 'block'
    // 底色层永远在（只是不显示壁纸），它就是"文档画布"的底色
    backdrop.style.display = 'block'

    reportOnce(
      'wall-painted',
      'wallpaper-painted',
      safe(function () {
        var r = wall.getBoundingClientRect()
        return {
          rect: { w: Math.round(r.width), h: Math.round(r.height) },
          computed: {
            zIndex: String(getComputedStyle(wall).zIndex),
            bgSize: String(getComputedStyle(wall).backgroundSize),
            bodyBg: String(getComputedStyle(document.body).backgroundColor),
            baseToken: String(getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base')).slice(0, 40),
          },
        }
      }, {}),
    )
  }

  // ------------------------------------------------------------ 标题栏探针

  /**
   * 读「窗口标题栏实际收到的颜色」。
   * Windows 上 Electron 用 titleBarOverlay，那三个系统按钮画在网页上面；
   * 宿主 preload 会插入一个隐藏探针 span、把它的计算样式经 IPC 交给主进程。
   * 所以读这个探针的计算样式，就知道标题栏真正会用什么底色。
   */
  function readTitlebarProbe() {
    return safe(function () {
      var found = null
      var kids = document.body ? document.body.children : []
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i]
        if (String(el.tagName || '').toLowerCase() !== 'span') continue
        var s = String(el.getAttribute('style') || '')
        if (s.indexOf('visibility') < 0 || s.indexOf('--dsw-specific-sidebar-fill') < 0) continue
        found = el
        break
      }
      var out = {
        windowsTitlebar: root.hasAttribute('data-windows-titlebar'),
        titlebarHeight: String(root.style.getPropertyValue('--dsh-windows-titlebar-height') || ''),
        splashActive: root.getAttribute('data-dshb-splash') === '1',
        probeFound: !!found,
        sidebarFill: String(getComputedStyle(root).getPropertyValue('--dsw-specific-sidebar-fill')).trim().slice(0, 32),
      }
      if (found) {
        var cs = getComputedStyle(found)
        out.probeBg = String(cs.backgroundColor).slice(0, 32)
        out.probeColor = String(cs.color).slice(0, 32)
      }
      return out
    }, { probeFound: false })
  }

  // ------------------------------------------------------------ 启动动画

  /** 等「宿主真的画出第一屏」再淡出启动动画。任何情况下都有硬兜底。 */
  function dismissSplash(reason) {
    var el = document.getElementById(SPLASH_ID)
    if (!el) {
      root.removeAttribute('data-dshb-splash')
      return
    }
    if (el.getAttribute('data-out') === '1') return
    var fill = el.querySelector('#' + SPLASH_ID + '-bar > i')
    if (fill) fill.style.width = '100%'
    reportOnce('splash-out', 'splash-dismissed', {
      reason: reason,
      at: Math.round(performance.now()),
      titlebarBeforeRestore: readTitlebarProbe(),
    })

    // 用 setTimeout 兜底，而不是 rAF：宿主负载高时 rAF 可能迟迟不执行
    setTimeout(function () {
      el.setAttribute('data-out', '1')
      // 宿主自己的启动占位已经让位，把界面交还给用户
      root.removeAttribute('data-dshb-splash')
      setTimeout(function () {
        safe(function () {
          el.remove()
        })
        var style = document.getElementById('dshb-prepaint-style')
        if (style) safe(function () {
          style.remove()
        })
      }, 320)
    }, 30)
  }

  function runSplash() {
    var el = document.getElementById(SPLASH_ID)
    if (!el) {
      // 兜底：绘制前脚本没跑成功（例如注入行被裁掉）时，也要让界面正常显示
      root.removeAttribute('data-dshb-splash')
      return
    }
    var sub = el.querySelector('#' + SPLASH_ID + '-sub')
    var fill = el.querySelector('#' + SPLASH_ID + '-bar > i')
    var start = performance.now()
    var steps = splashText
      ? [[0, splashText]]
      : [
          [0, '正在唤醒界面…'],
          [Math.max(220, splashMs * 0.35), '正在装载壁纸与主题…'],
          [Math.max(480, splashMs * 0.7), '就绪'],
        ]
    var minUntil = start + Math.max(0, Math.min(5000, splashMs))
    var ready = false
    var finished = false

    function tick() {
      if (finished) return
      var elapsed = performance.now() - start
      // 进度条：爬升曲线，永远不到 100%，直到真的就绪
      var ratio = Math.min(0.9, 0.12 + 0.78 * (1 - Math.exp(-elapsed / Math.max(240, minUntil - start))))
      if (fill) fill.style.width = Math.round(ratio * 100) + '%'
      if (sub) {
        for (var i = steps.length - 1; i >= 0; i--) {
          if (elapsed >= steps[i][0]) {
            if (sub.textContent !== steps[i][1]) sub.textContent = steps[i][1]
            break
          }
        }
      }
    }

    var timer = setInterval(tick, 90)
    tick()

    function finish(reason) {
      if (finished) return
      finished = true
      clearInterval(timer)
      dismissSplash(reason)
    }

    function maybeReady(reason) {
      if (ready) return
      ready = true
      var wait = Math.max(0, minUntil - performance.now())
      setTimeout(function () {
        finish(reason)
      }, wait)
    }

    /** 宿主首屏判据。 */
    function hostPainted() {
      return safe(function () {
        if (!document.querySelector('[class*="_boot_"]')) return true
        var host = document.getElementById('root')
        if (!host) return false
        var kids = host.children
        for (var i = 0; i < kids.length; i++) {
          var r = kids[i].getBoundingClientRect()
          if (r.width > 240 && r.height > 240) return true
        }
        return false
      }, false)
    }

    // 1) DOM 已经就绪就先看一眼
    if (document.readyState !== 'loading' && hostPainted()) maybeReady('already-painted')

    // 2) 用 MutationObserver 观察宿主的启动占位何时让位
    var observer = null
    safe(function () {
      observer = new MutationObserver(function () {
        if (hostPainted()) maybeReady('host-painted')
      })
      observer.observe(document.documentElement, { childList: true, subtree: true })
    })

    // 3) DOMContentLoaded 之后再确认一次
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        if (fill) fill.style.width = Math.max(58, parseFloat(fill.style.width) || 0) + '%'
        setTimeout(function () {
          if (hostPainted()) maybeReady('dom-ready-painted')
        }, 120)
      })
    }

    // 4) 硬兜底：无论宿主什么状态，启动动画最多展示 splashMs + 2.6s
    setTimeout(function () {
      finish('failsafe')
    }, Math.max(0, Math.min(5000, splashMs)) + 2600)

    // 5) 页面完全加载也算一个信号
    window.addEventListener('load', function () {
      setTimeout(function () {
        if (hostPainted()) maybeReady('load-painted')
      }, 60)
    })

    reportOnce('splash-in', 'splash-shown', {
      bar: splashBar,
      logo: splashLogo,
      minMs: splashMs,
      hasMark: !!el.querySelector('#' + SPLASH_ID + '-mark'),
      hasBar: !!el.querySelector('#' + SPLASH_ID + '-bar'),
      titlebar: readTitlebarProbe(),
      markDiag: safe(function () {
        var mk = el.querySelector('#' + SPLASH_ID + '-mark')
        if (!mk) return { found: false }
        var cs = getComputedStyle(mk)
        var r = mk.getBoundingClientRect()
        var fish = mk.querySelector('svg')
        var fr = fish ? fish.getBoundingClientRect() : null
        return {
          found: true,
          tag: String(mk.tagName),
          bg: String(cs.backgroundColor).slice(0, 26),
          display: String(cs.display),
          w: String(cs.width),
          h: String(cs.height),
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          fishRect: fr ? [Math.round(fr.left), Math.round(fr.top), Math.round(fr.width), Math.round(fr.height)] : null,
          word: String((el.querySelector('#' + SPLASH_ID + '-word') || {}).textContent || '').slice(0, 30),
        }
      }, { found: false }),
    })

    // 供 destroy 回收
    splashObserver = observer
    splashTimer = timer
    splashFinish = finish
  }

  var splashObserver = null
  var splashTimer = null
  var splashFinish = null

  // ------------------------------------------------------------ 偏好热跟随

  // 宿主每次请求都现读偏好文件，于是「外部改文件 → 页面自动变」。
  var watchTimer = null
  var lastSeen = null
  var lastProbe = null
  var probeRuns = 0

  function snapshot() {
    return [wallpaperOn, preset, mode, dim, saturate, transparency, blur, vignette, titlebarBlend, image].join('|')
  }

  function fetchPrefs() {
    fetch(ROUTES.prefs, { credentials: 'same-origin' })
      .then(function (res) {
        return res.json()
      })
      .then(function (data) {
        if (!data || data.ok !== true || !data.prefs) return
        var p = data.prefs
        // 开发期便利：偏好里把 probe 打开，页面无需重载就会 dump 一次宿主 DOM。
        // 判定用「上一个值」而不是「一次性」——调试时经常要反复开关对比两次快照。
        if (p.probe !== lastProbe) {
          lastProbe = p.probe
          if (p.probe === true) {
            probeRuns++
            report('probe-trigger', { run: probeRuns, prefs: snapshot() })
            setTimeout(function () {
              try {
                runProbe()
                report('probe-done', { run: probeRuns, ok: true })
              } catch (err) {
                // 探针自己出错也必须说出来，否则表现为"探针再也没跑过"，极难查
                report('probe-done', {
                  run: probeRuns,
                  ok: false,
                  error: String((err && err.stack) || (err && err.message) || err).slice(0, 500),
                })
              }
            }, 900)
          }
        }
        wallpaperOn = p.wallpaper !== false
        preset = PRESETS[p.preset] ? p.preset : preset
        mode = p.mode === 'light' || p.mode === 'dark' ? p.mode : 'auto'
        dim = clamp(p.dim, 0, 70, dim)
        saturate = clamp(p.saturate, 0, 160, saturate)
        transparency = clamp(p.transparency, 0, 100, transparency)
        blur = clamp(p.blur, 0, 32, blur)
        // surface 已固定 embed，不再从偏好读取
        vignette = p.vignette !== false
        titlebarBlend = p.titlebarBlend === true
        if (typeof p.image === 'string' && p.image !== image) {
          image = normalizeImageUrl(p.image)
          imageFailed = false
        }
        var next = snapshot()
        if (next === lastSeen) return
        lastSeen = next
        paintWallpaper()
        reportOnce('prefs-synced', 'prefs-synced', { prefs: next })
      })
      .catch(function () {})
  }

  // ------------------------------------------------------------ DOM 探针

  /**
   * 详细 DOM 体检：把宿主界面的真实结构、每个元素的不透明底色、可见性、
   * 文字对比度全部送回宿主。没有浏览器控制的环境里这是唯一的"眼睛"。
   * 触发方式：偏好 `probe: true`，或地址栏带 `?dsh-ui-miniskin=probe`。
   */
  function runProbe() {
    safe(function () {
      var out = []
      var host = document.getElementById('root') || document.body
      var count = 0
      var LIMIT = 900

      function css(el) {
        return getComputedStyle(el)
      }

      function walk(el, depth, path) {
        if (!el || count > LIMIT || depth > 16) return
        count++
        var r = el.getBoundingClientRect()
        var cs = css(el)
        var bg = String(cs.backgroundColor || '')
        var opaque = !!bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)'
        out.push({
          p: path,
          t: String(el.tagName || '').toLowerCase(),
          i: String(el.id || '').slice(0, 24),
          c: String(el.className || '').slice(0, 70),
          bg: bg.slice(0, 32),
          o: opaque,
          bi: String(cs.backgroundImage || '').slice(0, 40),
          z: String(cs.zIndex || ''),
          vis: String(cs.visibility || ''),
          op: String(cs.opacity || ''),
          ov: String(cs.overflowY || '') + '/' + String(cs.overflowX || ''),
          bf: String(cs.backdropFilter || cs.webkitBackdropFilter || '').slice(0, 24),
          r: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          d: depth,
        })
        var kids = el.children
        for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1, path + '/' + i)
      }

      walk(host, 0, '')

      // body 的直接子元素：界面到底画在哪个容器里
      var bodyKids = []
      safe(function () {
        var list = document.body ? document.body.children : []
        for (var i = 0; i < list.length; i++) {
          var el = list[i]
          var r = el.getBoundingClientRect()
          var cs = css(el)
          bodyKids.push({
            t: String(el.tagName || '').toLowerCase(),
            i: String(el.id || ''),
            c: String(el.className || '').slice(0, 60),
            vis: String(cs.visibility),
            op: String(cs.opacity),
            z: String(cs.zIndex),
            pos: String(cs.position),
            bg: String(cs.backgroundColor).slice(0, 28),
            bf: String(cs.backdropFilter || cs.webkitBackdropFilter || '').slice(0, 22),
            r: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          })
        }
      })

      // 命中测试：在视口上取若干个采样点，看最上层到底是谁
      var hits = []
      safe(function () {
        var points = [
          [140, 300],
          [600, 300],
          [600, 640],
          [Math.max(4, window.innerWidth - 40), Math.max(4, window.innerHeight - 24)],
          [Math.max(4, window.innerWidth - 200), 60],
        ]
        for (var i = 0; i < points.length; i++) {
          var at = document.elementFromPoint(points[i][0], points[i][1])
          hits.push({
            pt: points[i],
            hit: at ? String(at.tagName || '').toLowerCase() + '#' + String(at.id || '') + '.' + String(at.className || '').slice(0, 40) : null,
          })
        }
      })

      // 布局体检：侧栏头部几何（折叠按钮 vs 鲸鱼 Logo 是否重叠）
      var layout = []
      safe(function () {
        var probes = [
          { name: 'sidebarCol', sel: '[class*="BynINW_sidebarCol"]' },
          { name: 'sidebarRoot', sel: '[class*="_2H3hWW_root"]' },
          { name: 'logoRow', sel: '[class*="_2H3hWW_logoRow"]' },
          { name: 'brandMark(whale)', sel: '[class*="_2H3hWW_brandMark"]' },
          { name: 'headIconButton', sel: '[class*="_2H3hWW_iconButton"]' },
        ]
        for (var i = 0; i < probes.length; i++) {
          var el = document.querySelector(probes[i].sel)
          if (!el) {
            layout.push({ name: probes[i].name, found: false, sel: probes[i].sel })
            continue
          }
          var r = el.getBoundingClientRect()
          var cs = getComputedStyle(el)
          layout.push({
            name: probes[i].name,
            found: true,
            cls: String(el.className || '').slice(0, 40),
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            pos: String(cs.position),
            z: String(cs.zIndex),
            bg: String(cs.backgroundColor).slice(0, 26),
          })
        }
        safe(function () {
          var btn = document.querySelector('[class*="_2H3hWW_iconButton"]')
          var mark = document.querySelector('[class*="_2H3hWW_brandMark"]')
          if (!btn || !mark) return
          var a = btn.getBoundingClientRect()
          var b = mark.getBoundingClientRect()
          var ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
          var oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
          layout.push({
            name: 'overlap(button,whale)',
            found: true,
            area: Math.round(ox * oy),
            note: ox > 0 && oy > 0 ? '重叠' : '不重叠',
          })
        })
      })

      // 关键表面：计算后背景、backdrop-filter、背景图（壁纸内嵌档是否铺上）
      var surfaces = []
      safe(function () {
        for (var i = 0; i < HOST_SURFACES.length; i++) {
          var spec = HOST_SURFACES[i]
          var el = document.querySelector(spec.sel)
          if (!el) {
            surfaces.push({ name: spec.name, found: false, sel: spec.sel })
            continue
          }
          var cs = getComputedStyle(el)
          var r = el.getBoundingClientRect()
          surfaces.push({
            name: spec.name,
            found: true,
            sel: spec.sel,
            bg: String(cs.backgroundColor).slice(0, 32),
            token: String(cs.getPropertyValue(spec.token)).trim().slice(0, 32),
            backdrop: String(cs.backdropFilter || cs.webkitBackdropFilter || '').slice(0, 28),
            bgImage: String(cs.backgroundImage).slice(0, 500),
            bgAttach: String(cs.backgroundAttachment).slice(0, 30),
            radius: String(cs.borderRadius || ''),
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          })
        }
      })

      // 覆盖率：面积大且不透明的元素 → 合并矩形 → 「没有被挡住」的视口占比
      var coverage = null
      safe(function () {
        var W = window.innerWidth
        var H = window.innerHeight
        var rects = []
        var minArea = Math.max(0.004, 1 / 250) * W * H
        for (var i = 0; i < out.length; i++) {
          var n = out[i]
          if (!n.o) continue
          var rr = n.r
          if (rr[2] * rr[3] < minArea) continue
          var x1 = Math.max(0, rr[0])
          var y1 = Math.max(0, rr[1])
          var x2 = Math.min(W, rr[0] + rr[2])
          var y2 = Math.min(H, rr[1] + rr[3])
          if (x2 > x1 && y2 > y1) rects.push({ x1: x1, y1: y1, x2: x2, y2: y2, n: n.p + ' ' + n.c.slice(0, 24), bg: n.bg })
        }
        var area = 0
        var slice = 4
        for (var y = 0; y < H; y += slice) {
          var spans = []
          for (var j = 0; j < rects.length; j++) {
            var t = rects[j]
            if (y >= t.y1 && y < t.y2) spans.push([t.x1, t.x2])
          }
          if (!spans.length) continue
          spans.sort(function (a, b) {
            return a[0] - b[0]
          })
          var covered = 0
          var curS = spans[0][0]
          var curE = spans[0][1]
          for (var k = 1; k < spans.length; k++) {
            if (spans[k][0] <= curE) {
              if (spans[k][1] > curE) curE = spans[k][1]
            } else {
              covered += curE - curS
              curS = spans[k][0]
              curE = spans[k][1]
            }
          }
          covered += curE - curS
          area += covered * slice
        }
        var total = W * H
        coverage = {
          opaqueRects: rects.length,
          coveredPct: Math.round((area / total) * 1000) / 10,
          visiblePct: Math.round(((total - area) / total) * 1000) / 10,
          top: rects.slice(0, 8).map(function (t) {
            return t.n + ' ' + t.bg
          }),
        }
      })

      // 文字对比度体检：把"读不读得清"变成数字
      var contrast = []
      safe(function () {
        function parse(color) {
          var m = /rgba?\(([^)]+)\)/.exec(String(color))
          if (!m) return null
          var p = m[1].split(',').map(function (v) {
            return parseFloat(v)
          })
          return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]
        }
        function over(layers, base) {
          var out = base.slice()
          for (var i = 0; i < layers.length; i++) {
            var l = layers[i]
            if (!l || l[3] <= 0) continue
            out = [
              l[0] * l[3] + out[0] * (1 - l[3]),
              l[1] * l[3] + out[1] * (1 - l[3]),
              l[2] * l[3] + out[2] * (1 - l[3]),
            ]
          }
          return out
        }
        function lum(rgb) {
          var c = rgb.slice(0, 3).map(function (v) {
            v = v / 255
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
          })
          return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
        }
        function ratio(a, b) {
          var l1 = lum(a)
          var l2 = lum(b)
          return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100
        }
        var wallpaperBase = isDark() ? [10, 14, 26] : [214, 224, 245]
        var scrim = isDark() ? [6, 10, 20, dim / 100] : [22, 30, 50, dim / 100 + 0.12]
        var glassEl = document.getElementById(GLASS_ID)
        var glass = glassEl ? parse(getComputedStyle(glassEl).backgroundColor) : null

        var picks = [
          { name: 'sidebar-title', sel: '[class*="hIlkoa_title"]' },
          { name: 'sidebar-nav', sel: '[class*="BynINW_sidebarCol"] button' },
          { name: 'sidebar-row', sel: '[class*="hIlkoa_sessionRow"]' },
          { name: 'main-headline', sel: '[class*="Hqq-bq_headline"]' },
          { name: 'composer-input', sel: '[class*="RlGAzG_input"], textarea' },
        ]
        var themeSignals = {
          bodyAttrs: document.body
            ? Array.prototype.slice
                .call(document.body.attributes)
                .map(function (a) {
                  return a.name + '=' + String(a.value).slice(0, 24)
                })
                .join(' ')
            : '',
          htmlAttrs: Array.prototype.slice
            .call(root.attributes)
            .map(function (a) {
              return a.name + '=' + String(a.value).slice(0, 24)
            })
            .join(' '),
          prefersDark: !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches),
          colorScheme: String(getComputedStyle(root).colorScheme || ''),
          bodyColor: document.body ? String(getComputedStyle(document.body).color) : '',
          bodyBg: document.body ? String(getComputedStyle(document.body).backgroundColor) : '',
          labelPrimary: String(getComputedStyle(document.body).getPropertyValue('--dsw-alias-label-primary')).trim(),
        }
        for (var i = 0; i < picks.length; i++) {
          var el = document.querySelector(picks[i].sel)
          if (!el) {
            contrast.push({ name: picks[i].name, found: false })
            continue
          }
          var cs = getComputedStyle(el)
          var surface = parse(cs.backgroundColor)
          var surfaceEl = document.querySelector('[class*="BynINW_sidebarCol"]')
          var sBg = surfaceEl ? parse(getComputedStyle(surfaceEl).backgroundColor) : null
          var eff = over([glass, scrim], wallpaperBase)
          eff = over([sBg], eff)
          eff = over([surface], eff)
          var fg = parse(cs.color) || [0, 0, 0, 1]
          contrast.push({
            name: picks[i].name,
            found: true,
            color: String(cs.color).slice(0, 24),
            surfaceBg: String(cs.backgroundColor).slice(0, 24),
            effectiveBg: 'rgb(' + eff.slice(0, 3).map(Math.round).join(',') + ')',
            ratio: ratio(fg, eff),
          })
        }
        contrast.push({ name: 'theme-signals', found: true, signals: themeSignals })
      })

      // 令牌实测：这些是不是真的解析出了值
      var names = [
        '--dsw-alias-bg-base',
        '--dsw-alias-bg-layer-1',
        '--dsw-alias-bg-layer-2',
        '--dsw-alias-bg-layer-3',
        '--dsw-alias-bg-overlay',
        '--dsw-specific-sidebar-fill',
        '--dsw-alias-label-primary',
        '--dsw-alias-label-tertiary',
        '--dshb-transparency',
        '--dshb-blur',
      ]
      var tokens = names.map(function (n) {
        return { name: n, value: String(css(document.body).getPropertyValue(n)).trim().slice(0, 60) }
      })

      var meta = {
        // 注意：字段不能叫 theme —— report() 助手会用自己的主题摘要覆盖 payload.theme
        hostTheme: {
          dark: isDark(),
          // 用 hasAttribute 而不是 getAttribute：data-ds-dark-theme 的值是空串，
          // `getAttribute(...) || ''` 会把"已设置"和"未设置"混成一样（实测踩过）
          bodyAttr: document.body
            ? document.body.hasAttribute('data-ds-dark-theme') ? 'data-ds-dark-theme' : ''
            : '',
          htmlClass: String(root.className || '').slice(0, 80),
          bodyClass: document.body ? String(document.body.className || '').slice(0, 80) : '',
          htmlAttrs: {
            dshb: String(root.getAttribute('data-dshb') || ''),
            wall: String(root.getAttribute('data-dshb-wall') || ''),
            splash: String(root.getAttribute('data-dshb-splash') || ''),
            dark: String(root.getAttribute('data-dshb-dark') || ''),
            blend: String(root.getAttribute('data-dshb-blend') || ''),
          },
        },
        tokens: tokens,
        bodyKids: bodyKids,
        hits: hits,
        surfaces: surfaces,
        coverage: coverage,
        layout: layout,
        contrast: contrast,
        titlebar: readTitlebarProbe(),
        counts: { nodes: out.length, truncated: count > LIMIT },
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
        // 把本插件实际生成的样式表带回来自查：规则到底长什么样、有没有被写坏
        generatedCss: safe(function () {
          var styleEl = document.getElementById(STYLE_ID)
          return styleEl ? String(styleEl.textContent || '').slice(0, 12000) : '(无)'
        }, '(读不到)'),
      }

      try {
        report('dom-probe-meta', meta)
      } catch (err) {
        // meta 自报本身失败也必须留痕（否则表现为"探针没跑过"，极难查）
        report('dom-probe-meta-failed', {
          error: String((err && err.message) || err).slice(0, 300),
        })
      }

      // 分批发「有信息量」的节点（成片不透明底/带模糊/有 id 的大块），避免报文超限
      var interesting = []
      safe(function () {
        var W = window.innerWidth
        var H = window.innerHeight
        var minArea = 0.004 * W * H
        for (var i = 0; i < out.length; i++) {
          var n = out[i]
          var area = n.r[2] * n.r[3]
          if (n.o && area >= minArea) interesting.push(n)
          else if (n.bf) interesting.push(n)
          else if (n.i && area >= minArea) interesting.push(n)
          // 按钮也一律收录：找设置触发器等小控件时，它们既不大也不带背景
          else if (n.t === 'button') interesting.push(n)
        }
      })
      var chunkSize = 60
      for (var s = 0; s < interesting.length; s += chunkSize) {
        report('dom-probe-part', {
          part: Math.floor(s / chunkSize),
          of: Math.ceil(interesting.length / chunkSize),
          nodes: interesting.slice(s, s + chunkSize),
        })
      }
    })
  }

  // ------------------------------------------------------------ 生命周期

  var themeObserver = null
  var errorHandler = null

  function destroy() {
    if (watchTimer !== null) clearInterval(watchTimer)
    watchTimer = null
    if (splashTimer !== null) clearInterval(splashTimer)
    splashTimer = null
    if (splashObserver) safe(function () {
      splashObserver.disconnect()
    })
    splashObserver = null
    if (themeObserver) safe(function () {
      themeObserver.disconnect()
    })
    themeObserver = null
    if (errorHandler) window.removeEventListener('error', errorHandler)
    var ids = [WALL_ID, BACKDROP_ID, SCRIM_ID, GLASS_ID, STYLE_ID, SPLASH_ID]
    for (var i = 0; i < ids.length; i++) {
      removeById(ids[i])
    }
    root.removeAttribute('data-dshb-splash')
    root.removeAttribute('data-dshb-wall')
  }

  /** 单独一个函数，避免在循环里闭包捕获同一个变量。 */
  function removeById(id) {
    var el = document.getElementById(id)
    if (!el) return
    safe(function () {
      el.remove()
    })
  }

  // ------------------------------------------------------------ 启动

  try {
    // 幂等：重复载入（HMR / 多次注入）先撤掉上一个实例。
    var previous = document.getElementById(WALL_ID)
    if (previous && typeof previous.__dshbDestroy === 'function') safe(previous.__dshbDestroy)
    else if (previous) safe(function () {
      previous.remove()
    })

    // 壁纸：无论开关如何都先把层建好
    paintWallpaper()

    // 主题跟随：宿主在 body 上切 data-ds-dark-theme。变了要整体重绘 ——
    // 壁纸本身也分深浅两套，只改 data 属性是不够的。
    safe(function () {
      var lastDark = isDark()
      themeObserver = new MutationObserver(function () {
        var now = isDark()
        if (now === lastDark) return
        lastDark = now
        reportOnce('theme-change-' + (now ? 'dark' : 'light'), 'theme-changed', { dark: now })
        paintWallpaper()
      })
      themeObserver.observe(document.body || root, {
        attributes: true,
        attributeFilter: ['data-ds-dark-theme', 'class'],
      })
    })

    // 自定义图片加载失败 → 退回渐变，并记一条自报
    safe(function () {
      if (preset === 'image' && image) {
        var probe = new Image()
        probe.onerror = function () {
          imageFailed = true
          report('image-failed', { image: image.slice(0, 200) })
          paintWallpaper()
        }
        probe.src = image
      }
    })

    // 启动动画
    if (splashOn) safe(runSplash)
    else safe(function () {
      var el = document.getElementById(SPLASH_ID)
      if (el) el.remove()
      root.removeAttribute('data-dshb-splash')
    })

    errorHandler = function (event) {
      report('window-error', { message: String((event && (event.message || event.error)) || '').slice(0, 300) })
    }
    window.addEventListener('error', errorHandler)

    // 挂载自报：延迟到入场过渡结束之后测量，否则 opacity 会读到中间值
    setTimeout(function () {
      safe(function () {
        var wall = document.getElementById(WALL_ID)
        var rect = wall ? wall.getBoundingClientRect() : null
        reportOnce('mounted', 'mounted', {
          rect: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
          viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
          layers: {
            wall: !!wall,
            wallZ: wall ? String(getComputedStyle(wall).zIndex) : '',
            wallDisplay: wall ? String(getComputedStyle(wall).display) : '',
            scrim: !!document.getElementById(SCRIM_ID),
            glass: !!document.getElementById(GLASS_ID),
            backdrop: !!document.getElementById(BACKDROP_ID),
            splashInDom: !!document.getElementById(SPLASH_ID),
          },
          bodyBg: document.body ? String(getComputedStyle(document.body).backgroundColor) : '',
          baseToken: document.body
            ? String(getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base')).slice(0, 40)
            : '',
          readyState: document.readyState,
        })
      })
    }, 620)

    // 探针：偏好打开，或地址栏显式要求时跑一次
    try {
      if (CFG.probe === true || String(location.search || '').indexOf('dsh-ui-miniskin=probe') >= 0) {
        setTimeout(runProbe, 1500)
      }
    } catch (err) {
      /* 忽略 */
    }

    // 图片自诊断（probe 打开时一起触发；probe 在宿主白名单里，页面一定拿得到）：
    // 在同一页面里分别验证 ① <img> 能否加载该图 ② canvas 能否解码
    // ③ div 的 background-image 能否带上该图。
    // ③ 会画一个 200×200 的测试块钉在右上角，配合截图即可判定 CSS 背景是否真的渲染。
    if (CFG.probe === true) {
      setTimeout(function () {
        try {
          var diagUrl = image
          var diagDiv = document.createElement('div')
          diagDiv.id = 'dshb-image-diag'
          diagDiv.style.cssText =
            'position:fixed;top:60px;right:20px;width:200px;height:200px;z-index:2147483000;' +
            'background-image:url("' + String(diagUrl).replace(/"/g, '%22') + '");' +
            'background-size:cover;border:2px solid #f00;pointer-events:none'
          document.body.appendChild(diagDiv)
          var diagImg = new Image()
          diagImg.onload = function () {
            report('image-diag-img', { stage: 'img-loaded', w: diagImg.naturalWidth, h: diagImg.naturalHeight })
          }
          diagImg.onerror = function () {
            report('image-diag-img', { stage: 'img-error' })
          }
          diagImg.src = diagUrl
          var diagCanvas = document.createElement('canvas')
          var diagCtx = diagCanvas.getContext('2d')
          var diagImg2 = new Image()
          diagImg2.onload = function () {
            try {
              diagCanvas.width = Math.min(64, diagImg2.naturalWidth)
              diagCanvas.height = Math.min(64, diagImg2.naturalHeight)
              diagCtx.drawImage(diagImg2, 0, 0, diagCanvas.width, diagCanvas.height)
              var pd = diagCtx.getImageData(0, 0, 1, 1).data
              report('image-diag-canvas', { stage: 'decoded', px: [pd[0], pd[1], pd[2], pd[3]] })
            } catch (e2) {
              report('image-diag-canvas', { stage: 'decode-error', error: String((e2 && e2.message) || e2).slice(0, 200) })
            }
          }
          diagImg2.onerror = function () {
            report('image-diag-canvas', { stage: 'img-error' })
          }
          diagImg2.src = diagUrl
          report('image-diag-start', {
            url: String(diagUrl).slice(0, 140),
            divComputedBg: safe(function () {
              return String(getComputedStyle(diagDiv).backgroundImage).slice(0, 160)
            }, '(读不到)'),
          })
        } catch (err) {
          report('image-diag-failed', { error: String((err && err.message) || err).slice(0, 300) })
        }
      }, 2500)
    }

    // 偏好热跟随：宿主每次请求都现读偏好文件，所以「改文件 → 页面自动变」
    safe(function () {
      watchTimer = setInterval(fetchPrefs, 2000)
      fetchPrefs()
    })

    var wallEl = document.getElementById(WALL_ID)
    if (wallEl) wallEl.__dshbDestroy = destroy
  } catch (err) {
    // 初始化崩溃：把错误交回宿主，本体保持静默退出（界面不会因此挂掉）
    report('init-failed', { message: String((err && err.stack) || (err && err.message) || err).slice(0, 600) })
    root.removeAttribute('data-dshb-splash')
  }
})()
