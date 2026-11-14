# <片名> · 分镜

**所有时刻来自 narration.json 实测锚点，不手填秒数。** 改 json 后跑：
`python3 <film-story>/scripts/check_shotlist.py --film <slug> --write`

按状态阶段、情绪换挡或句中揭示切镜，避免机械地每念完一句切一镜等长配图。物理跨度 ≠ 叙事权重：重要转折单独绑定锚点并写进 `segments`。转场需要前后两镜短暂交叠时声明 `overlap`（秒数或 `pads` 名）。

```json
{
  "pads": {},
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

## 镜头设计
<!-- 每镜一行：景别 · 机位与角度 · 运动 · 动机（揭示/强调/跟随/对比什么）· 焦点 · 交棒。平铺不动也写明理由。见 references/cinematography.md -->

## 关键帧：剪影描述与形似风险
<!-- 每个 keyframe 一条。剪影描述 = 没听旁白的人眯眼看 360px 宽会说"这是什么形状"，写出主要元素的位置和大小关系。9x16 注意避开底部约 20% 平台文案遮挡区。 -->
### <keyframe 锚点>
剪影描述：
要像：
不能像：

## 交棒
<!-- 镜头之间靠什么连续：状态延续 / 共享元素 / 叠化交叠（overlap）/ 主题断点硬切 … 见 references/vocabulary.md -->
