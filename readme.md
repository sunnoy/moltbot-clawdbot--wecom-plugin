# 远程环境

```bash
# 看日志
sshpass -p 'tsgx^$^W%fABG5hW' ssh -o StrictHostKeyChecking=no root@10.0.0.23 "cd /root/molt && docker compose logs"

# 代码录
/root/molt/config/extensions/wxwork

# 调试
需要scp到远程服务器，然后通过docker compose来重启服务
sshpass -p 'tsgx^$^W%fABG5hW' scp -o StrictHostKeyChecking=no 'root@10.0.0.23'
# moltbot源码
/tmp/moltbot

```

# todo

- 图片、图文混排、文件、语音等接收消类型实现
- ~~流式回复~~ ✅ 已实现 (利用Moltbot的BufferedBlockDispatcher + 被动回复streamManager + 企业微信流式刷新机制)
- 指令处理
- 会话管理
- 用户隔离
- skills注入
- 命令黑名单
- 




# 指令
https://developer.work.weixin.qq.com/document/path/101031 添加用户当天首次进入智能机器人单聊会话，回复欢迎语 回复

你好，可以使用下面指令管理会话
/new 新建会话
/compact 压缩会话

 Slash commands
/help - Show available commands.
/commands - List all slash commands.
/skill - Run a skill by name.
/status - Show current status.
/allowlist (text-only) - List/add/remove allowlist entries.
/approve - Approve or deny exec requests.
/context - Explain how context is built and used.
/tts - Configure text-to-speech.
/whoami (aliases: /id) - Show your sender id.
/subagents - List/stop/log/info subagent runs for this session.
/usage - Usage footer or cost summary.
/stop - Stop the current run.
/restart - Restart Clawdbot.
/activation - Set group activation mode.
/send - Set send policy.
/reset - Reset the current session.
/new - Start a new session.
/compact (text-only) - Compact the session context.
/think (aliases: /thinking, /t) - Set thinking level.
/verbose (aliases: /v) - Toggle verbose mode.
/reasoning (aliases: /reason) - Toggle reasoning visibility.
/elevated (aliases: /elev) - Toggle elevated mode.
/exec - Set exec defaults for this session.
/model - Show or set the model.
/models - List model providers or provider models.
/queue - Adjust queue settings.
/dock_telegram (aliases: /dock-telegram) - Switch to telegram for replies.
/dock_discord (aliases: /dock-discord) - Switch to discord for replies.
/dock_slack (aliases: /dock-slack) - Switch to slack for replies.
/bluebubbles - Build or update the BlueBubbles external channel plugin for Clawdbot (extension package, REST send/…
/github - Interact with GitHub using the  ⁠gh⁠  CLI. Use  ⁠gh issue⁠ ,  ⁠gh pr⁠ ,  ⁠gh run⁠ , and  ⁠gh api⁠  for issues…
/notion - Notion API for creating and managing pages, databases, and blocks.
/skill_creator - Create or update AgentSkills. Use when designing, structuring, or packaging skills with scripts, re…
/slack - Use when you need to control Slack from Clawdbot via the slack tool, including reacting to messages…
/weather - Get current weather and forecasts (no API key required).