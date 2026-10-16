import os, sys
from PIL import Image

SRC = "E:/86187/Desktop/Mahjong/preview-bg"
DST = "E:/86187/Desktop/Mahjong/packages/client/src/assets/bg"
STRIP = 72  # 覆盖底部水印的条带高度

MAP = {
    "Seamless_tiling_game_backgroun_2026-10-15T04-47-35.png": "bg-lattice.png",
    "Seamless_tiling_game_backgroun_2026-10-15T04-47-40.png": "bg-cloud.png",
    "Seamless_tiling_game_backgroun_2026-10-15T04-47-32.png": "bg-felt-dots.png",
}

os.makedirs(DST, exist_ok=True)
for src_name, dst_name in MAP.items():
    sp = os.path.join(SRC, src_name)
    if not os.path.exists(sp):
        print("MISSING", sp); sys.exit(1)
    im = Image.open(sp).convert("RGB")
    W, H = im.size
    # 无缝 tile：顶边应等于底边；把顶部条带复制到底部，覆盖底部水印且保持垂直平铺
    top = im.crop((0, 0, W, STRIP))
    im.paste(top, (0, H - STRIP))
    # 同步水平：把左侧条带复制到右侧，覆盖可能的右侧水印
    side = 72
    left = im.crop((0, 0, side, H))
    im.paste(left, (W - side, 0))
    out = os.path.join(DST, dst_name)
    im.save(out, "PNG")
    print(f"OK {dst_name} {W}x{H} -> {out}")
