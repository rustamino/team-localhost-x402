; Benchy demo gcode - x402 hackathon placeholder
; Models: Benchy Speed Boat / Mini Benchy
; Estimated: 12.4g, 47 min (sliced at 0.2mm layer, 20% infill)
;
; ACTUAL PRINT START
G21 ; metric
G90 ; absolute positioning
M82 ; extruder absolute
M104 S210 ; set hotend temp (no wait)
M140 S60  ; set bed temp (no wait)
G28       ; home all axes
M109 S210 ; wait for hotend
M190 S60  ; wait for bed
G92 E0
; purge line
G1 X5 Y5 Z0.3 F5000
G1 X150 E15 F1500
G92 E0
; --- placeholder: in production, real sliced gcode goes here ---
G1 Z10 F3000
G28 X Y
M104 S0
M140 S0
M84
