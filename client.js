/**
 * dsh-ui-miniskin —— 客户端模块（浏览器侧）：把插件设置注册进宿主自己的设置面板。
 *
 * 路线说明：不再自挂右下角胶囊，改走官方 slot 体系（settings.section）——
 * 宿主设置面板（侧栏底部「设置」或 Ctrl+, 打开）的导航里会多出「界面美化」一节。
 *
 * 注册结构（都从宿主源码实测确认过）：
 * - `settings.section` 是 list 槽：每次注册 = 设置导航里的一个条目（id/order/label），
 *   组件负责渲染整节内容；
 * - 槽的 `children` 声明子槽（kind: list, scope: root），组件里用 renderSlot 渲染；
 * - `inject` 返回对象的 `hooks: { x: store }` 会变成组件的 `useX(selector)` 属性
 *   （用 useSyncExternalStore 绑定，store 需要 getSnapshot/subscribe），
 *   其余键原样作为组件属性传入（宿主 settings-general 就是这么用的）。
 *
 * 数据流：本模块维护一个外部 store；面板改动 POST 给宿主的 /prefs.json（写盘），
 * 宿主响应里是清洗后的完整偏好 → 更新 store。前端本体（assets/widget.js）每 2 秒
 * 拉一次偏好并热应用，所以这里改完 2 秒内界面就变，无需重启。
 *
 * 注意：这个文件由宿主客户端的模块系统打包加载，不能用 ESM import，
 * 只能 `require('react')`（React 是模块表里的基线依赖，模板同款用法）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-ui-miniskin',
  factory(require) {
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef, useCallback } = React

    const PACKAGE = 'dsh-ui-miniskin'
    const ROUTES = {
      prefs: '/' + PACKAGE + '/prefs.json',
      report: '/' + PACKAGE + '/report.json',
    }

    // ------------------------------------------------------------ 常量

    /** 预设缩略图。与 assets/widget.js 的 PRESETS 深色变体保持一致（维护时两处同改）。 */
    const PRESET_SWATCH = {
      aurora:
        'radial-gradient(900px 620px at 12% 8%, rgba(96,165,250,.68), transparent 60%),' +
        'radial-gradient(820px 560px at 88% 4%, rgba(167,139,250,.60), transparent 62%),' +
        'radial-gradient(900px 700px at 70% 96%, rgba(45,212,191,.44), transparent 60%),' +
        'linear-gradient(160deg, #070b18 0%, #101a33 52%, #060912 100%)',
      nebula:
        'radial-gradient(720px 520px at 22% 12%, rgba(244,114,182,.42), transparent 60%),' +
        'radial-gradient(760px 560px at 82% 20%, rgba(129,140,248,.48), transparent 62%),' +
        'radial-gradient(900px 700px at 50% 100%, rgba(56,189,248,.28), transparent 60%),' +
        'linear-gradient(200deg, #0b0716 0%, #1b1030 55%, #07040f 100%)',
      dusk:
        'radial-gradient(760px 520px at 18% 10%, rgba(251,146,60,.40), transparent 60%),' +
        'radial-gradient(860px 600px at 84% 34%, rgba(244,63,94,.32), transparent 62%),' +
        'linear-gradient(170deg, #140a12 0%, #2a1424 50%, #0d070c 100%)',
      ocean:
        'radial-gradient(900px 640px at 26% 10%, rgba(56,189,248,.42), transparent 62%),' +
        'radial-gradient(920px 660px at 78% 90%, rgba(30,64,175,.46), transparent 62%),' +
        'linear-gradient(175deg, #04101c 0%, #082a45 55%, #03080f 100%)',
      forest:
        'radial-gradient(820px 560px at 20% 12%, rgba(74,222,128,.32), transparent 60%),' +
        'radial-gradient(880px 620px at 84% 86%, rgba(20,83,45,.55), transparent 62%),' +
        'linear-gradient(168deg, #06120c 0%, #0d2a1c 55%, #040a07 100%)',
      sakura:
        'radial-gradient(780px 540px at 22% 10%, rgba(255,182,193,.50), transparent 62%),' +
        'radial-gradient(820px 600px at 80% 88%, rgba(196,132,252,.34), transparent 62%),' +
        'linear-gradient(172deg, #1a0f16 0%, #2c1a26 52%, #120a11 100%)',
      paper:
        'radial-gradient(900px 600px at 30% 6%, rgba(148,163,184,.20), transparent 62%),' +
        'linear-gradient(168deg, #0b0d12 0%, #14171f 60%, #0a0c11 100%)',
      carbon:
        'repeating-linear-gradient(135deg, rgba(255,255,255,.030) 0 2px, transparent 2px 7px),' +
        'repeating-linear-gradient(45deg, rgba(255,255,255,.022) 0 2px, transparent 2px 9px),' +
        'linear-gradient(170deg, #08090d 0%, #12141b 60%, #07080c 100%)',
      image:
        'linear-gradient(140deg,#2b3350,#141a2b)',
    }
    const PRESET_LABEL = {
      aurora: '极光',
      nebula: '星云',
      dusk: '暮色',
      ocean: '深海',
      forest: '森野',
      sakura: '樱雾',
      paper: '素纸',
      carbon: '碳纤',
      image: '自定义',
    }
    const PRESET_ORDER = ['aurora', 'nebula', 'dusk', 'ocean', 'forest', 'sakura', 'paper', 'carbon', 'image']

    const MODE_OPTIONS = [
      ['auto', '跟随宿主'],
      ['dark', '强制深色'],
      ['light', '强制浅色'],
    ]
    const TITLEBAR_OPTIONS = [
      ['flat', '同色条带'],
      ['gradient', '融入动画'],
      ['none', '不画条带'],
    ]

    const DEFAULTS = {
      wallpaper: true,
      preset: 'aurora',
      mode: 'auto',
      image: '',
      dim: 22,
      saturate: 100,
      transparency: 44,
      blur: 14,
      surface: 'embed',
      vignette: true,
      splash: true,
      splashMs: 1100,
      splashLogo: true,
      splashBar: true,
      splashText: '',
      titlebar: 'flat',
      titlebarBlend: false,
    }

    // ------------------------------------------------------------ 样式

    /** 只用宿主主题令牌 + 不透明兜底（与前端本体同一套规矩）。 */
    const CSS = [
      '.dshbs-section{display:flex;flex-direction:column;width:100%;gap:2px}',
      '.dshbs-row{display:flex;justify-content:space-between;align-items:center;gap:24px;',
      'padding:13px 0;border-bottom:.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))}',
      '.dshbs-row:last-child{border-bottom:none}',
      '.dshbs-title{font-size:14px;line-height:20px;',
      'color:var(--dsw-alias-label-primary, #1f2328)}',
      '.dshbs-desc{color:var(--dsw-alias-label-secondary, rgba(31,35,40,.65));',
      'margin-top:4px;font-size:12px;line-height:18px}',
      '.dshbs-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0 2px}',
      '.dshbs-swatch{position:relative;height:52px;border-radius:8px;cursor:pointer;',
      'overflow:hidden;border:1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12));',
      'background-size:cover;background-position:center}',
      '.dshbs-swatch span{position:absolute;left:0;right:0;bottom:0;padding:2px 0;',
      'font-size:11px;text-align:center;color:#fff;background:rgba(0,0,0,.45)}',
      '.dshbs-swatch[data-on="1"]{outline:2px solid var(--dsw-alias-brand-primary, #4d6bfe);',
      'outline-offset:1px}',
      '.dshbs-range{width:150px;accent-color:var(--dsw-alias-brand-primary, #4d6bfe)}',
      '.dshbs-val{font-variant-numeric:tabular-nums;',
      'color:var(--dsw-alias-label-tertiary, rgba(31,35,40,.55));',
      'font-size:12px;min-width:38px;text-align:right}',
      '.dshbs-btns{display:flex;gap:6px;flex-wrap:wrap}',
      '.dshbs-btn{padding:4px 10px;border-radius:8px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12));background:transparent;',
      'color:var(--dsw-alias-label-primary, #1f2328);',
      'font:500 12px/18px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif}',
      '.dshbs-btn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))}',
      '.dshbs-btn[data-on="1"]{border-color:var(--dsw-alias-brand-primary, #4d6bfe);',
      'color:var(--dsw-alias-brand-primary, #4d6bfe)}',
      '.dshbs-input{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l3, rgba(0,0,0,.12));',
      'background:var(--dsw-alias-bg-layer-1, #ffffff);color:inherit;',
      'font:400 13px/18px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif}',
      '.dshbs-flex{display:flex;gap:8px;align-items:center;width:100%}',
      '.dshbs-btn:disabled{opacity:.55;cursor:default}',
      '.dshbs-check{accent-color:var(--dsw-alias-brand-primary, #4d6bfe);',
      'width:16px;height:16px;cursor:pointer}',
      '.dshbs-note{color:var(--dsw-alias-label-secondary, rgba(31,35,40,.65));',
      'font-size:12px;line-height:18px;padding:8px 0 2px}',
    ].join('')

    // ------------------------------------------------------------ 自报

    function report(event, extra) {
      try {
        fetch(ROUTES.report, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ event: event, version: 'client' }, extra || {})),
          keepalive: true,
        }).catch(function () {})
      } catch (err) {
        /* 自报失败不影响设置面板 */
      }
    }

    // ------------------------------------------------------------ 偏好 store

    function createPrefsStore(initial) {
      let snapshot = Object.assign({}, DEFAULTS, initial)
      const listeners = new Set()
      return {
        getSnapshot: function () {
          return snapshot
        },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () {
            listeners.delete(listener)
          }
        },
        set: function (next) {
          snapshot = Object.assign({}, snapshot, next)
          for (const listener of Array.from(listeners)) {
            try {
              listener()
            } catch (err) {
              /* 单个监听器出错不拖垮其它 */
            }
          }
        },
      }
    }

    // ------------------------------------------------------------ 组件

    /** 设置节的外壳：把本节的 item 子槽渲染进来（与宿主 GeneralSection 同构）。 */
    function Section(props) {
      return h(
        'div',
        { className: 'dshbs-section' },
        props.renderSlot ? props.renderSlot('settings.ui-beautify.item', {}) : null,
      )
    }

    function Row(props) {
      return h(
        'div',
        { className: 'dshbs-row' },
        h(
          'div',
          { style: { minWidth: 0 } },
          h('div', { className: 'dshbs-title' }, props.title),
          props.desc ? h('div', { className: 'dshbs-desc' }, props.desc) : null,
        ),
        props.control,
      )
    }

    function Slider(props) {
      const value = typeof props.value === 'number' ? props.value : props.fallback
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        h('input', {
          className: 'dshbs-range',
          type: 'range',
          min: String(props.min),
          max: String(props.max),
          step: String(props.step || 1),
          value: String(value),
          onChange: function (event) {
            props.onChange(Number(event.target.value))
          },
        }),
        h('div', { className: 'dshbs-val' }, String(value)),
      )
    }

    function Check(props) {
      return h('input', {
        className: 'dshbs-check',
        type: 'checkbox',
        checked: !!props.checked,
        'aria-label': props.title,
        onChange: function (event) {
          props.onChange(event.target.checked)
        },
      })
    }

    function Buttons(props) {
      return h(
        'div',
        { className: 'dshbs-btns' },
        props.options.map(function (pair) {
          const on = props.value === pair[0]
          return h(
            'button',
            {
              key: pair[0],
              className: 'dshbs-btn',
              'data-on': on ? '1' : '0',
              type: 'button',
              onClick: function () {
                props.onChange(pair[0])
              },
            },
            pair[1],
          )
        }),
      )
    }

    /** 设置面板本体：一个组件渲染全部控件。 */
    function Panel(props) {
      const useBeautify = props.useBeautify
      const save = props.save
      const prefs = useBeautify ? useBeautify(function (p) {
        return p
      }) : DEFAULTS

      // 挂载即自报：这是「设置节真的渲染出来」的直接证据（外部没有浏览器控制时尤其重要）
      useEffect(function () {
        report('settings-panel-mounted', { at: Date.now() })
      }, [])

      const [imageDraft, setImageDraft] = useState(typeof prefs.image === 'string' ? prefs.image : '')
      const lastImage = useRef(null)
      useEffect(function () {
        if (lastImage.current === null && typeof prefs.image === 'string') lastImage.current = prefs.image
        else if (typeof prefs.image === 'string' && prefs.image !== lastImage.current) {
          lastImage.current = prefs.image
          setImageDraft(prefs.image)
        }
      }, [prefs.image])

      const commit = useCallback(function (patch) {
        save(patch)
      }, [save])

      const commitImage = useCallback(function () {
        const next = imageDraft.trim()
        if (next !== prefs.image) save({ image: next, preset: 'image' })
      }, [imageDraft, prefs.image, save])

      // ---- 选择文件：<input type="file"> 打开原生文件对话框 → 读文件 →
      // 上传到本插件自己的路由（存进插件目录）→ 拿回 http 地址填进同一个偏好字段。
      const [uploading, setUploading] = useState(false)
      const fileRef = useRef(null)

      const pickImageFile = useCallback(function () {
        if (fileRef.current) fileRef.current.click()
      }, [])

      const onImagePicked = useCallback(function (event) {
        const input = event.target
        const file = input && input.files && input.files[0]
        if (!file) return
        input.value = '' // 清掉，让「再选同一个文件」也能触发 change
        if (file.size > 16 * 1024 * 1024) {
          report('image-upload-failed', { error: 'too-large', size: file.size })
          return
        }
        setUploading(true)
        const reader = new FileReader()
        reader.onerror = function () {
          setUploading(false)
          report('image-upload-failed', { error: 'read-failed', name: String(file.name).slice(0, 60) })
        }
        reader.onload = function () {
          try {
            const base64 = String(reader.result).split(',')[1] || ''
            fetch('/dsh-ui-miniskin/image-upload', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: file.name, data: base64 }),
            })
              .then(function (res) {
                return res.json()
              })
              .then(function (data) {
                setUploading(false)
                if (data && data.ok && typeof data.url === 'string') {
                  setImageDraft(data.url)
                  save({ image: data.url, preset: 'image' })
                  report('image-uploaded', { url: data.url.slice(0, 160) })
                } else {
                  report('image-upload-failed', { error: String((data && data.error) || 'bad-response') })
                }
              })
              .catch(function (err) {
                setUploading(false)
                report('image-upload-failed', { error: String((err && err.message) || err).slice(0, 200) })
              })
          } catch (err) {
            setUploading(false)
            report('image-upload-failed', { error: String((err && err.message) || err).slice(0, 200) })
          }
        }
        reader.readAsDataURL(file)
      }, [save])

      const value = function (key, fallback) {
        return prefs && typeof prefs[key] !== 'undefined' ? prefs[key] : fallback
      }

      return h(
        'div',
        null,
        // ---- 壁纸
        h(Row, {
          title: '壁纸预设',
          desc: '点一下立即切换（桌面端跟随系统主题时，深浅两套会自动对应）',
          control: h(
            'div',
            { className: 'dshbs-grid', style: { width: '100%' } },
            PRESET_ORDER.map(function (name) {
              const on = value('preset', 'aurora') === name
              return h(
                'div',
                {
                  key: name,
                  className: 'dshbs-swatch',
                  'data-on': on ? '1' : '0',
                  role: 'button',
                  tabIndex: 0,
                  style: { backgroundImage: PRESET_SWATCH[name] },
                  onClick: function () {
                    commit({ preset: name })
                  },
                },
                h('span', null, PRESET_LABEL[name]),
              )
            }),
          ),
        }),
        h(Row, {
          title: '遮罩深度',
          desc: '在壁纸之上压一层暗色，数字越大壁纸越暗、文字越稳',
          control: h(Slider, {
            value: value('dim', 22), min: 0, max: 70, step: 1,
            onChange: function (v) { commit({ dim: v }) },
          }),
        }),
        h(Row, {
          title: '壁纸饱和',
          desc: '对内置渐变预设生效（自定义图片是位图，无法调饱和）',
          control: h(Slider, {
            value: value('saturate', 100), min: 0, max: 160, step: 5,
            onChange: function (v) { commit({ saturate: v }) },
          }),
        }),
        h(Row, {
          title: '界面透明',
          desc: '越大壁纸越透出来（壁纸内嵌档：半透底色+壁纸的配比）',
          control: h(Slider, {
            value: value('transparency', 44), min: 0, max: 100, step: 5,
            onChange: function (v) { commit({ transparency: v }) },
          }),
        }),
        h(Row, {
          title: '毛玻璃模糊',
          desc: '设为 0：输入框与周围完全一致（无分界）。调大后输入框会变成一块独立的磨砂面板 —— 与周围存在可见分界，这是磨砂玻璃本身的代价',
          control: h(Slider, {
            value: value('blur', 0), min: 0, max: 32, step: 1,
            onChange: function (v) { commit({ blur: v }) },
          }),
        }),
        h(Row, {
          title: '四周暗角',
          control: h(Check, {
            checked: value('vignette', true),
            onChange: function (v) { commit({ vignette: v }) },
          }),
        }),
        h(Row, {
          title: '启用壁纸',
          control: h(Check, {
            checked: value('wallpaper', true),
            onChange: function (v) { commit({ wallpaper: v }) },
          }),
        }),

        // ---- 配色
        h(Row, {
          title: '壁纸配色',
          desc: '只决定壁纸走哪一套，不改变宿主主题（宿主主题请在宿主设置里切）',
          control: h(Buttons, {
            value: value('mode', 'auto'),
            options: MODE_OPTIONS,
            onChange: function (v) { commit({ mode: v }) },
          }),
        }),

        // ---- 自定义图片
        h(Row, {
          title: '自定义图片',
          desc: '点上方预设里的「自定义」格，然后点「选择文件…」从本地选图（推荐，自动存进插件目录，重启后依然生效）。文字颜色会自动跟随图片亮度：深图配浅色文字、亮图配深色文字，图片本身保持清晰。外网 https 图片会被宿主安全栅栏拦截，可能加载失败',
          control: h(
            'div',
            { className: 'dshbs-flex' },
            h('input', {
              className: 'dshbs-input',
              type: 'text',
              value: imageDraft,
              placeholder: 'https://…/a.jpg 或 file:///C:/Users/你/壁纸.jpg',
              style: { flex: 1, minWidth: 0 },
              onChange: function (event) {
                setImageDraft(event.target.value)
              },
              onBlur: commitImage,
              onKeyDown: function (event) {
                if (event.key === 'Enter') commitImage()
              },
            }),
            h(
              'button',
              {
                className: 'dshbs-btn',
                type: 'button',
                disabled: uploading,
                onClick: pickImageFile,
              },
              uploading ? '上传中…' : '选择文件…',
            ),
            h('input', {
              ref: fileRef,
              type: 'file',
              accept: 'image/*',
              style: { display: 'none' },
              onChange: onImagePicked,
            }),
          ),
        }),

        // ---- 启动动画
        h(Row, {
          title: '启动动画',
          desc: '首帧起效：改完需要重启客户端（启动最早期绘制）',
          control: h(Check, {
            checked: value('splash', true),
            onChange: function (v) { commit({ splash: v }) },
          }),
        }),
        h(Row, {
          title: '最短停留 (毫秒)',
          desc: '实际时长 = max(本值, 宿主首屏耗时)。改动会保留，下次启动生效',
          control: h(Slider, {
            value: value('splashMs', 1100), min: 0, max: 3000, step: 50,
            onChange: function (v) { commit({ splashMs: v }) },
          }),
        }),
        h(Row, {
          title: '标题栏（右上角系统按钮）',
          desc: '按钮画在网页上层只能改底色；默认把底色和动画顶部调成同一个值',
          control: h(Buttons, {
            value: value('titlebar', 'flat'),
            options: TITLEBAR_OPTIONS,
            onChange: function (v) { commit({ titlebar: v }) },
          }),
        }),
        h(Row, {
          title: '标题栏融入壁纸',
          desc: '把窗口最上方那 40px 的标题栏底色设成透明，露出下面的壁纸 —— 右上角系统按钮直接浮在皮肤上。开关立即生效（非启动动画期间的标题栏）',
          control: h(Check, {
            checked: value('titlebarBlend', false),
            onChange: function (v) { commit({ titlebarBlend: v }) },
          }),
        }),
        h(Row, {
          title: '立即重播一次启动动画',
          desc: '重载页面。完全尊重你当前的「最短停留」设置',
          control: h(
            'button',
            {
              className: 'dshbs-btn',
              type: 'button',
              onClick: function () {
                props.replay()
              },
            },
            '重播',
          ),
        }),
        h(
          'div',
          { className: 'dshbs-note' },
          '偏好保存在 $DSH_HOME/.dsh-ui-miniskin.json，改完立即生效并跨重启保留。',
        ),
      )
    }

    // ------------------------------------------------------------ 模块

    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式只注入一次
        if (typeof document !== 'undefined' && !document.getElementById('dshbs-style')) {
          const style = document.createElement('style')
          style.id = 'dshbs-style'
          style.textContent = CSS
          ;(document.head || document.documentElement).appendChild(style)
        }

        const store = createPrefsStore(
          typeof globalThis !== 'undefined' && globalThis.__DSH_UI_MINISKIN__
            ? globalThis.__DSH_UI_MINISKIN__
            : {},
        )

        /**
         * 写偏好：POST 给宿主（写盘 + 清洗），响应里的完整偏好更新 store。
         * 失败时把错误自报出来 —— 设置面板必须能自证"保存到底成没成"。
         */
        function save(patch) {
          return fetch(ROUTES.prefs, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch || {}),
          })
            .then(function (res) {
              return res.json()
            })
            .then(function (data) {
              if (data && data.ok === true && data.prefs) store.set(data.prefs)
              report('settings-saved', { patch: patch, ok: !!(data && data.ok) })
            })
            .catch(function (err) {
              report('settings-save-failed', { error: String((err && err.message) || err).slice(0, 200) })
            })
        }

        function replay() {
          try {
            if (typeof location !== 'undefined') location.reload()
          } catch (err) {
            /* 忽略 */
          }
        }

        /** 挂载时与宿主同步一次偏好（注入的 CFG 是启动时快照，可能已过期）。 */
        function refresh() {
          fetch(ROUTES.prefs, { credentials: 'same-origin' })
            .then(function (res) {
              return res.json()
            })
            .then(function (data) {
              if (data && data.ok === true && data.prefs) store.set(data.prefs)
            })
            .catch(function () {})
        }

        // ① 设置导航里的「界面美化」节
        ctx.slots.inject('settings.section', function () {
          const dispose = ctx.slots.register({
            name: 'settings.section',
            id: 'ui-beautify',
            order: 30,
            label: function () {
              return '界面美化'
            },
            children: {
              'settings.ui-beautify.item': { kind: 'list', scope: 'root' },
            },
          }, Section)
          // 注册真正落账后自报一次：列出当前设置导航里的全部节，证明本节的条目在场
          report('settings-section-registered', {
            sections: ctx.slots.entries('settings.section').map(function (e) {
              return String(e.options.id || '')
            }),
          })
          return dispose
        })

        // ② 节内容：一个面板组件装下全部控件
        ctx.slots.inject('settings.ui-beautify.item', function () {
          return ctx.slots.register({
            name: 'settings.ui-beautify.item',
            id: 'panel',
            order: 0,
            inject: function () {
              return { hooks: { beautify: store }, save: save, replay: replay }
            },
          }, Panel)
        })

        // 面板每次挂载时刷新一次偏好
        refresh()

        // 自报：让外部能确认「客户端模块真的注册成功了」
        report('client-slot-registered', {
          section: 'ui-beautify',
          at: Date.now(),
        })

        // 延迟再报一次设置导航全量：宿主各节（常规/插件…）的注册顺序不受保证，
        // 第一次报可能只有本节；3 秒后应能看到完整导航共存。
        setTimeout(function () {
          try {
            report('settings-section-ledger', {
              sections: ctx.slots.entries('settings.section').map(function (e) {
                return String(e.options.id || '')
              }),
            })
          } catch (err) {
            report('settings-section-ledger-failed', { error: String((err && err.message) || err).slice(0, 200) })
          }
        }, 3000)
      },
    }
  },
})
