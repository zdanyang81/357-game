# 357 好友联网：隔离内测客户端（未真机验收）

本轮新增联网模式，不替代原来的离线同屏、人机、三选先手、左右取骰、本地存档和战绩。首页「好友联网」进入独立大厅，创建房间或输入4位数字房间码后本人确认加入。房间码不是微信号或手机号，也不能用来查找微信用户。微信好友邀请只带 `room` 参数；分享被平台拦截时，仍靠这4位数字加入。冷启动和回前台均只预填，不自动切房、加入或发送头像。

## 微信原生好友邀请

玩家添加采用微信原生会话选择邀请，不新增357用户账号，不采集手机号或微信联系人名单，也不提供按微信号/手机号查找任意微信用户的输入入口。玩家在等待房间点击「邀请微信好友」，由微信界面选择接收人并自行确认转发；受邀人打开卡片后，仍须本人确认加入。

房间邀请调用 `wx.shareAppMessage` 并显式设置 `toCurrentGroup: false`。按[官方参数说明](https://developers.weixin.qq.com/minigame/dev/api/share/wx.shareAppMessage.md)，从群工具栏打开时该参数默认为 `true`（转发当前群），设为 `false` 才允许选择其他会话；该选项最低支持基础库2.12.2。拉起界面不等于已发送、好友接受或已入房；不宣称能可靠检测用户取消分享。

本项新增选项契约回归；从群工具栏进入后选择另一位好友，以及双方各自手机确认加入，仍待真实微信验证。原有隐私指引、备案、游戏资质与提审发布要求不因此解除。

## 配置与传输

`minigame/online-config.js` 默认 `apiBase: ''`，此时建房/加入明确禁用；由管理员在隔离构建中配置合法 HTTPS API base，不从分享参数接受服务端地址。正常微信必须配置对应 request 合法域名、有效证书，且当期小游戏账号和后台权限支持；不关闭 urlCheck 绕过。房间接口精确契约由服务端文档维护。

HTTPS 请求通过平台适配层发出；约1.5秒**可见时轮询**，不是 WSS，不宣称已测低延迟。房间码是短期邀请凭证，token 只置于请求 Authorization，不进入分享、URL或本地存档。双方只提交行、数量、actionId、expectedRevision，服务端校验并返回权威状态；客户端不乐观判胜，不接入本地 AI，不记入旧离线战绩。建房/加入响应未知时停止继续操作；走子响应未知先查询快照，不自动重复走子。隐藏暂停轮询，回来重新查询；旧代数/旧版本回调不覆盖新状态。退出进程不保存 token，房间随内存服务超时清理。

## 自愿头像与隐私

- 默认内置形象始终可玩，不以微信头像/相册授权解锁游戏。
- 相册优先 `wx.chooseMedia({count:1,mediaType:['image'],sourceType:['album'],sizeType:['compressed']})`；旧版仅兼容 `wx.chooseImage`。本地临时路径只在本机加载，裁成96×96 PNG 后才可作为头像入房；不上传原图、文件路径、昵称、手机号或 OpenID。
- 微信头像使用小游戏原生 `wx.createUserInfoButton({type:'text',withCredentials:false,...})`，只在头像选择界面用户点击后处理 `res.userInfo.avatarUrl`，压缩成同样的 PNG；退出/隐藏销毁原生按钮。没有使用小程序 WXML `open-type="chooseAvatar"`，不虚构 `wx.chooseAvatar`。
- API存在不保证取得非灰微信头像；用户必须实际预览，拒绝、空头像、受限或加载失败可继续内置/相册。当前尚未核实目标AppID和iOS/Android真实微信返回非灰头像。
- 选择前使用小游戏 `wx.requirePrivacyAuthorize`；自定义隐私回调通过 `wx.openPrivacyContract` 展示后台指引，报告曝光/同意/拒绝。缺少能力或后台声明时失败关闭，不绕过。入房前再次说明「自选头像将发送到357内测服务并仅向本房间对手展示，房间过期清除」，本人确认后才上传。
- 管理员必须在小游戏后台声明昵称头像/选中的照片或视频信息等实际范围，描述头像传输、对手展示、内存保存、删除与内容安全措施。旧首版文档“不联网、不处理微信头像”仅描述旧离线模式，不能作为新联网功能的隐私承诺。内测仍需安全与合规把关；图片格式校验不等于内容安全审核。

## 官方依据与验收边界

- [小游戏用户信息获取](https://developers.weixin.qq.com/minigame/dev/guide/open-ability/user-info.html)
- [小游戏用户信息原生按钮](https://developers.weixin.qq.com/minigame/dev/api/open-api/user-info/wx.createUserInfoButton.html)
- [小游戏 chooseMedia](https://developers.weixin.qq.com/minigame/dev/api/media/video/wx.chooseMedia.html)；[chooseImage 停止维护说明](https://developers.weixin.qq.com/minigame/dev/api/media/image/wx.chooseImage.html)
- [小游戏隐私合规](https://developers.weixin.qq.com/minigame/dev/guide/open-ability/privacy.html)
- [分享 query](https://developers.weixin.qq.com/minigame/dev/api/share/wx.shareAppMessage.html)；[onShow](https://developers.weixin.qq.com/minigame/dev/api/base/app/life-cycle/wx.onShow.html)；[冷启动参数](https://developers.weixin.qq.com/minigame/dev/api/base/app/life-cycle/wx.getLaunchOptionsSync.html)
- [网络域名、证书与后台限制](https://developers.weixin.qq.com/minigame/dev/guide/base-ability/network.html)；[测试号预览/调试边界](https://developers.weixin.qq.com/minigame/dev/devtools/sandbox.html)

运行 `node --test tests/*.test.js` 和旧三组逻辑回归只证明本地自动化；平台测试使用 mock，不代表微信工具、原生输入、隐私指引、头像 PNG 编码/图片载入、分享入口、两个微信账号/两手机网络、前后台弱网或真实延迟通过。需要真实小游戏AppID、后台声明与正常HTTPS合法域名，并逐项两机验收。正式发布、主体资质、提审与公开开放另行确认，本实现不是上线证明。
