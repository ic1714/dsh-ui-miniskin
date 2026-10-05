# dsh-ui-miniskin

DSH 界面美化插件：**启动动画** + **界面壁纸**。设置集成在 DSH 自带设置面板里，
装上即用，不改变任何宿主功能。

## 功能

- **启动动画**：官方鲸鱼 Logo + 产品名 + 进度条，首帧绘制前就铺上品牌底图
  （不会先闪一下宿主的白底），等宿主画出第一屏再淡出，任何异常都有硬兜底。
- **界面壁纸**：9 套内置预设（极光 / 星云 / 暮色 / 深海 / 森野 / 樱雾 / 素纸 / 碳纤），
  每套都有深浅两套配色；支持自定义图片（「选择文件…」本地选图，文字颜色自动跟随
  图片亮度：深图浅字、亮图深字）。
- **细节可调**：遮罩深度、壁纸饱和、界面透明、毛玻璃、四周暗角、标题栏融入壁纸，
  全部 2 秒内热生效、跨重启保留。

## 安装

```powershell
# 1. 克隆
git clone https://github.com/ic1714/dsh-ui-miniskin.git

# 2. 用软链装进你的 profile（改源码立即生效）
dsh plugin --profile desktop add link:<克隆后的目录绝对路径>
```

装好后**完全退出并重开客户端**，打开 设置（桌面端 `Ctrl+,`）→ 「界面美化」即可使用。

## 使用

| 分组 | 选项 |
|---|---|
| 壁纸 | 9 个预设缩略图 · 遮罩深度 0-70 · 壁纸饱和 0-160 · 界面透明 0-100 · 毛玻璃模糊 0-32 · 四周暗角 · 启用壁纸 |
| 标题栏 | 标题栏融入壁纸（窗口最上方 40px 透明化，系统按钮浮在皮肤上） |
| 壁纸配色 | 跟随宿主 / 强制深色 / 强制浅色 |
| 自定义图片 | 「选择文件…」从本地选图（自动存进插件目录，重启后依然生效） |
| 启动动画 | 开关 · 最短停留 0-3000ms · 标题栏条带三档 · 立即重播 |

偏好写在 `$DSH_HOME/.dsh-ui-miniskin.json`，卸载插件不会自动删除。

## 配置项

```jsonc
{
  "wallpaper": true,      // 壁纸总开关
  "preset": "aurora",     // aurora|nebula|dusk|ocean|forest|sakura|paper|carbon|image
  "mode": "auto",         // auto=跟随宿主主题；dark/light=强制走那一套壁纸配色
  "image": "",            // preset=image 时的图片地址
  "dim": 22,              // 遮罩深度 0-70（越大壁纸越暗）
  "saturate": 100,        // 壁纸饱和 0-160（仅内置渐变预设）
  "transparency": 44,     // 界面透明 0-100（越大壁纸越透出来）
  "blur": 0,              // 输入卡片磨砂 0-32（>0 时输入框成为独立磨砂面板）
  "vignette": true,       // 四周暗角
  "splash": true,         // 启动动画
  "splashMs": 1100,       // 最短停留（实际 = max(本值, 宿主首屏耗时)）
  "splashText": "",       // 自定义副标题（留空用内置文案）
  "titlebar": "flat",     // 启动动画顶部条带：flat|gradient|none
  "titlebarBlend": false, // 日常标题栏融入壁纸（透明化）
  "probe": false          // 调试开关：dump 一次宿主 DOM 到自报通道
}
```

## 文件结构

```
dsh-ui-miniskin/
├── package.json          # 包清单（dsh.client + dsh.bundle.patch）
├── cordis.patch.yml      # 挂载声明
├── lib/index.js          # 宿主半边：注入行 + 路由 + 偏好
├── client.js             # 客户端模块：设置面板集成（settings.section 槽）
└── assets/
    ├── widget.js         # 前端本体：壁纸层 + 启动动画接管
    └── titlebar-probe.html # 标题栏取色自检页
```

## 已知限制

- 自定义图片是位图，无法调「壁纸饱和」；加载失败会自动退回极光渐变。
- 外网 `https://…` 图片会被宿主的安全栅栏拦截（桌面端页面跑在 `dsh-app://`
  自定义协议上），建议用「选择文件…」。
- 「毛玻璃模糊」调大后输入框会变成一块独立的磨砂面板，与周围存在可见分界。

## 许可

代码以 [MIT](./LICENSE) 许可发布。

> 启动动画中的鲸鱼图标是 DeepSeek 官方 Logo，版权归 DeepSeek 所有，
> 仅作品牌展示使用，不包含在 MIT 许可范围内。