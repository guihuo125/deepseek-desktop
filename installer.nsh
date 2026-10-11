; ============ DeepSeek 安装程序自定义 ============

; 1. 强制中文（SimpChinese.nlf 已存在）
!macro customHeader
!macroend

; 2. 安装前钩子
!macro preInit
  ; 禁用最大化按钮
  ; 设置默认安装目录
!macroend

; 3. 自定义欢迎页文字（可覆盖英文）
!macro customWelcomePage
!macroend

; 4. 初始化 - 强制语言
!macro customInit
!macroend

; 5. 安装完成后
!macro customInstall
!macroend

; 6. 卸载前
!macro customUnInstall
!macroend

; 7. 卸载时是否删除用户数据
!macro customRemoveFiles
!macroend