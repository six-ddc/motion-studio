# <片名> · 分镜

**所有时刻来自 narration.json 实测锚点，不手填秒数。** 改 json 后跑：
`python3 <film-storyboard>/scripts/check_shotlist.py --film <slug> --write`

镜头按机制状态的阶段切，不按句子切。叙事权重 ≠ 物理时长：重要区间要有自己的旁白锚点，并写进 segments。

```json
{
  "pads": {"lead": 0, "tail": 0},
  "vo_offset": "lead",
  "shots": [
    {"id": "1", "from": "start", "to": "s1.end", "does": "", "mech": "", "handoff": ""}
  ],
  "curves": {},
  "segments": [],
  "claims": [],
  "keyframes": [
    {"at": "s1", "read": ""}
  ]
}
```

## 时间表（脚本生成）
<!-- timeline:begin -->
<!-- timeline:end -->

## 关键帧：剪影描述与形似风险
<!-- 每个 keyframe 一条。剪影描述 = 没听旁白的人眯眼看 360px 宽会说"这是什么形状"，写出主要元素的位置和大小关系。 -->
### <keyframe 锚点>
剪影描述：
要像：
不能像：

## 交棒
<!-- 镜头之间靠什么连续：状态延续 / 共享元素 / 主题断点上的硬切 … 见 references/vocabulary.md -->
