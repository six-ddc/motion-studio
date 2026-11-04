# 火山引擎豆包语音：两个接口、模型、语气控制

目录：官方核实 · 2.0 语气控制机制 · 对照 · volcano-stream 请求体 · volcano-audio 请求体 · 返回码 · 网络 · 调试

两个接口都已在 `scripts/tts.py` 中实现。凭证放在仓库根目录 `.env` 的 `VOLC_TTS_API_KEY` 里（在新版控制台的「API Key 管理」中获取），代码和文档只提变量名。
实测数据见仓库 docs/verified/film-narration.md 第 2、12、26 节。

## 官方核实（2026-10-21 查阅）

| 结论 | 来源 |
|---|---|
| 本 skill 使用 **HTTP Chunked 单向流 `POST /api/v3/tts/unidirectional`**（另外还有 WebSocket 双向流和单向流、HTTP SSE） | [HTTP Chunked/SSE 单向流式-V3](https://www.volcengine.com/docs/6561/1598757) |
| `X-Api-Resource-Id` 的取值：`seed-tts-2.0`（只能调用 2.0 音色）、`seed-tts-1.0` / `seed-tts-1.0-concurr`（1.0 音色）、`seed-icl-2.0` / `seed-icl-1.0` / `seed-icl-1.0-concurr`（声音复刻） | 同上 |
| 最新的合成模型是 2.0（2025-09）；2026 年新增的是音色设计模型（本 skill 没有接入，也没有测试）、音频生成 1.0 和实时语音 3.0 | [产品动态](https://docs.volcengine.com/docs/DoubaoVoice/Productdynamics) |
| `req_params.model` 的 `seed-tts-2.0-standard` / `-expressive` **只对声音复刻 2.0 生效** | HTTP 单向流文档 |
| 音频生成 `seed-audio-1.0`：`POST /api/v3/tts/create`，`text_prompt` 不超过 3000 字符（人声文本建议不超过 400），音频不超过 2 min，非流式；本账号已调通 | [音频生成](https://docs.volcengine.com/docs/DoubaoVoice/audio-generation-http)、[模型列表](https://docs.volcengine.com/docs/DoubaoVoice/model-list) |
| 官方[音色列表](https://www.volcengine.com/docs/6561/1257544)每一行只有场景、名称、voice_type、语种/方言、支持能力和特殊标签，**没有逐个音色的文字描述**；`*_uranus_bigtts` 的能力一律是「指令遵循」，`ICL_uranus_*_tob` 的能力一列为空，但用 `seed-tts-2.0` 可以调通 | 音色列表 |

## 2.0 的语气/表达控制

| 机制 | 写法 | 范围 | 官方限制 | 本账号实测结论 |
|---|---|---|---|---|
| 语音指令 `additions.context_texts` | `["你可以说慢一点吗？"]` | 整次请求 | 适用于 2.0 音色和复刻 2.0 表现力版；**只有第一个值有效**；不计费 | 生效，但**强度因音色而异**（云舟的时长变化 ±13–15%，知性灿灿只有 ±3–5%）；情绪类指令在基频和响度上测不出差别 |
| 引用上文（同样放在 `context_texts`） | 放入上文，只作引用、不合成 | 同上 | 和语音指令共用唯一有效的那一个位置 | 接口接受，不会被念出来；指标没有差别 |
| `additions.section_id` | 多次请求使用同一个 UUID 串联 | 跨请求 | 仅限 2.0 | 接口接受；指标没有差别 |
| 控制台写法 `[#指令]` | 写进 HTTP 请求的 `text` | — | 文档没有说明 HTTP 接口能否这样写 | **会被念出来**，多计费，时间戳自检失败，因此由 `tts.py` 在本地解析成 `context_texts` |
| `use_tag_parser` + `<cot text=…>` | — | 单句少于 64 字 | 只适用于复刻 2.0 表现力版 | 用在 2.0 音色上时标签会被念出来 |
| `audio_params.emotion` / `emotion_scale` | `"angry"`，强度 1–5 | 整段 | 仅部分 1.0 多情感音色支持 | 2.0 音色上没有可测的变化，也不报错 |
| SSML `req_params.ssml` | `<break time>` 等 | — | 官方说明 2.0 音色「暂不支持」，带 SSML 时不返回字幕 | 能产生停顿，但**时间戳会被挤压**，并按 SSML 字符串计费，所以不能用在需要字级时间戳的旁白上 |
| `max_length_to_filter_parenthesis` | 默认 100 | — | — | 2.0 上括号里的文字照样被念出来 |
| `speech_rate` / `loudness_rate` | 取值 [-50, 100]，100 表示 2 倍 | 整段 | — | 生效 |
| `additions.post_process.pitch` | [-12, 12] 半音 | 整段 | — | 生效且精确（纯后处理变调） |
| 标点「，」「——」「……」 | — | 局部 | — | 停顿逐级变长，时间戳不受影响；「……」会返回为两个「…」token |
| `silence_duration` | 0–30000 ms | **只作用在整段末尾** | — | 没有重新测试 |

官方来源：[HTTP 单向流参数表](https://www.volcengine.com/docs/6561/1598757)、[语音指令与标签](https://docs.volcengine.com/docs/DoubaoVoice/DoubaoTextToSpeech20CapabilityIntroduction)、[SSML 标记语言](https://docs.volcengine.com/docs/DoubaoVoice/SSMLmarkuplanguage)、[模型列表](https://docs.volcengine.com/docs/DoubaoVoice/model-list)。

## 对照

| | volcano-stream | volcano-audio |
|---|---|---|
| 端点 | `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional` | `POST https://openspeech.bytedance.com/api/v3/tts/create` |
| 模型 | header `X-Api-Resource-Id: seed-tts-2.0`（复刻音色用 `seed-icl-2.0`） | body 里的 `model: seed-audio-1.0` |
| 鉴权 | `X-Api-Key` + `X-Api-Resource-Id` + `X-Api-Request-Id`(uuid) | `X-Api-Key` + `X-Api-Request-Id`；旧版控制台可以用 `X-Api-App-Id` + `X-Api-Access-Key` |
| 响应 | HTTP Chunked，返回**一串首尾相接的 JSON 对象**，每块可能带 `data`(base64 音频片段) / `sentence` / `usage` | 单个 JSON：`audio`(base64) + `subtitle` + `original_duration` |
| 时间戳 | `sentence.words[].{word, startTime, endTime, confidence}`，单位为**秒** | `subtitle.sentences[].words[].{text, start_time, end_time}`，单位为**毫秒**，没有置信度 |
| 标点 token | 粘在前一个字上，带时长（`数。`） | **独立成 token，宽度为零**（`，` 的 start == end），所以不能假设 `end > start` |
| 计费 | 按文本字数（header 带上 `X-Control-Require-Usage-Tokens-Return: *` 时会返回 `usage.text_words`）；`context_texts` 不计费 | 按音频秒数 `original_duration` 计费，单次不超过 120s |
| 独有能力 | 发音词典、语音指令、30 多个语种、方言、声音复刻 | 用自然语言描述音效和多人对白、参考音频或图片、时间轴控制 |

## volcano-stream 请求体

```json
{"req_params": {
  "text": "…（tts.py 已去掉行内标记）",
  "speaker": "zh_male_m191_uranus_bigtts",
  "model": "(仅复刻音色)",
  "ssml": "(可选，给了不读 text)",
  "audio_params": {"format": "mp3", "sample_rate": 44100, "speech_rate": 0,
                   "loudness_rate": 0, "bit_rate": 0, "enable_subtitle": true},
  "additions": "{\"pronunciation_dict\": {\"tone\": [\"密钥/密月\"]}, \"context_texts\": [\"你可以说慢一点吗？\"], \"post_process\": {\"pitch\": -2}}"
}}
```

- **`additions` 是经过 JSON 序列化的字符串**，而不是对象。其中可以包含 `pronunciation_dict` `explicit_language` `explicit_dialect` `silence_duration`
  `max_length_to_filter_parenthesis` `disable_markdown_filter` `disable_emoji_filter` `latex_parser`
  `enable_auto_language_recognition` `context_texts` `section_id` `post_process` `tone_fidelity` `aigc_watermark`。
- script.json 字段与这里的映射关系见 `references/schemas.md`。`enable_subtitle: true` 是字级时间戳的开关，**只对中英文**生效。
- 发音词典最多 5000 条，每个词不超过 9 个字符，只适用于中英文音色。拼音写法 `北京/(bei3)(jing1)` 接口能接受，但改不了读音；文本转写（`密钥/密月`、`omg/oh my god`）可以生效。详见 `references/pronunciation.md`。

## volcano-audio 请求体

```json
{"model": "seed-audio-1.0",
 "text_prompt": "<promptPrefix><text>",
 "references": [{"speaker": "zh_male_m191_uranus_bigtts"}],
 "audio_config": {"format": "mp3", "sample_rate": 44100, "speech_rate": 0,
                  "loudness_rate": 0, "pitch_rate": 0, "enable_subtitle": true},
 "watermark": "(可选)"}
```

- `references[0]` 里的 `speaker` / `audio_data` / `audio_url` / `image_data` / `image_url` **五个只能给一个**。`text_prompt` 可以是纯文本，也可以是一段描述，例如「先是一声手机震动，环境中持续鸟鸣，男子1（中年，嗓音低沉）严肃地说……」。
- 这个接口不识别 `instruction` / `context_texts`，语气要用自然语言写进 `promptPrefix`。

## 返回码

| 码 | 含义 | 处理 |
|---|---|---|
| `0` | 成功 | — |
| `20000000` (`message=OK`) | 流式会话**正常结束**的事件 | 不是错误。`SUCCESS_CODES = {0, 20000000}` |
| `40402003` | 文本超长 | 拆句 |
| `45000000` | 音色未授权，或并发超限 | 换音色；`voices.py` 会把它标为 ✗ |
| 其他非 0 值 | 失败 | 脚本带上 `logid`（响应头 `X-Tt-Logid`）后以退出码 1 退出 |
| HTTP 4xx/5xx | 鉴权、参数或额度问题 | 脚本打印响应体的前 800 个字符后以退出码 1 退出 |

## 网络

这台机器做了 TLS 拦截：Python 直连会报 `CERTIFICATE_VERIFY_FAILED`，curl 则正常。`make_ssl_context()` 按以下优先级选择证书：
`VOLC_TTS_CA_BUNDLE` / `SSL_CERT_FILE` 指定的 CA 包 > `truststore`（系统钥匙串）> certifi 默认。

## 调试

`tts.py --film <slug> --dry-run` 会打印第一句的完整请求（key 已打码），不实际发送请求，也不计费；如果第一句带有行内标记，会先列出切出来的各段。
`--engine volcano-audio --dry-run` 可以确认 audio 接口的请求构造是否正确，而不必花费按秒计费的钱。
