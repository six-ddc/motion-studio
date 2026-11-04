# 本片法律（测试片）

纸、墨、一点朱砂。只有直线运动，所有东西沿水平或竖直方向走。

- 只用三色：纸 #EDE4D3、墨 #1F1C18、朱砂 #B33A28
- 不出现曲线运动
- 朱砂只出现一次，用在"印"上
- 静止可以有，但不超过 1.5 秒——这支片子短，停太久就断气了

```critique
{
  "palette": ["#EDE4D3", "#1F1C18", "#B33A28"],
  "max_still": 1.5,
  "loop": true,
  "min_text_src_px": { "latin": 26, "latin_bold": 30, "cjk": 56, "cjk_bold": null },
  "laws": [
    { "id": "no-curve", "text": "不出现曲线运动", "how": "看 strip.png 里连续帧的位移方向；stills 只能看到位置不能看到轨迹" },
    { "id": "cinnabar-once", "text": "朱砂只出现一次，用在印上", "how": "contact.png 里数红色出现的格子" }
  ]
}
```
