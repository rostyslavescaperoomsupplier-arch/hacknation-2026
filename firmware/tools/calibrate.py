#!/usr/bin/env python3
"""Average the RSSI of one anchor from the wristband serial log (TX_1M calibration).

    pio device monitor -d firmware/wristband | python3 firmware/tools/calibrate.py D3-05 30

Hold the band 1 m from the anchor, wrist at chest height, facing it. Prints mean and median
after N samples; put the result in `tx` of that anchor in ANCHORS (assistant/shared/positions.ts).
"""
import statistics
import sys

if len(sys.argv) < 2:
    sys.exit(__doc__)
anchor = sys.argv[1]
want = int(sys.argv[2]) if len(sys.argv) > 2 else 30
vals = []
for line in sys.stdin:
    parts = line.split()
    if len(parts) == 3 and parts[0] == "rssi" and parts[1] == anchor:
        vals.append(int(parts[2]))
        print(f"{len(vals):3d}/{want}  {vals[-1]} dBm", flush=True)
        if len(vals) >= want:
            break
if vals:
    print(f"{anchor}: mean {statistics.mean(vals):.1f} dBm, median {statistics.median(vals)} dBm, "
          f"stdev {statistics.pstdev(vals):.1f}, n={len(vals)}")
