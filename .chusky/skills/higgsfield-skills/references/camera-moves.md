# Camera Movement Prompt Bank

Source: Higgsfield Academy Camera Prompt Bank (https://higgsfield.ai/academy/apps/prompt-bank) and the AI video camera-control blog (https://higgsfield.ai/blog/ai-video-camera-control).

How to use: paste the move into the shot line of any video prompt. Bracketed values are tunable defaults (distance, degrees, speed, framing); replace them only if the user wants something different. Rules: one move per shot; name what the camera is not doing ("no zoom", "no cuts"); give start and end framing; test at 720p before 1080p.

Extra precision patterns from the camera-control blog: pan left exactly 90 degrees over 6 seconds; zoom from 18mm to 84mm while camera stays fixed; 360-degree orbit at radius [2.5] meters; tracking shot with three parallax layers (foreground, subject, background). Aperture cues: f/1.4 dreamy bokeh, f/4 balanced, f/11 everything sharp.


## Static

### Static shot
```
The camera stays planted in one immovable position from the first frame to the last. Zero motion — no drift, no shake, no breathing, no stabilization float, no micro-drift; absolute rock-solid stillness throughout. Angle, elevation, distance to the scene and the overall composition are frozen and never altered; every ounce of motion comes from the scene itself, never from the camera. The clip closes on precisely the framing it began with, identical down to the pixel.
```


## Pan & tilt

### Pan right
```
Rotate the camera horizontally from left to right from one fixed point, like a standing head-turn, starting on [composition A] and sweeping across [the environment]; no sideways travel, no dolly, no truck, no arc, no slide, no zoom, no tilt. Speed: smooth constant rotation, decelerating gently at the end. Framing: keep the horizon level while new space enters from the right side of the frame only through rotation; [the landing subject] stays beyond the right edge until the rotation brings them in. End: settle on a clear final composition on [the landing subject] and hold.
```

### Tilt up
```
Fixed camera position at [lens height]. Pure TILT UP: the camera rotates vertically upward at one constant smooth speed from [the lower anchor] to [the upper framing], no crane rise, no pedestal, no dolly, no zoom, no horizontal drift; the camera's position never changes. The tilt starts on [the lower anchor] and finishes framing [the subject] in the upper third, decelerating into a static hold.
```


## Zoom & focus

### Zoom in
```
Locked tripod, zero rotation, zero travel — the entire move is optical, a focal-length change only: one slow perfectly even continuous zoom in from [84] degrees to [29 or 18] degrees across the full duration, no speed changes, no steps, no wobble. The camera position is fixed and never moves; only the field of view changes; perspective stays constant and there is no parallax — the background keeps the exact same apparent size relative to the subject while the framing tightens.
```

### Dolly zoom
```
The camera physically dollies forward from [6] meters to [2.5] meters while the lens simultaneously zooms out from [18] to [84] degrees field of view, in one continuous, perfectly synchronized ramp. The subject's head size stays EXACTLY constant in frame the entire time; the background behind them visibly stretches, elongates and recedes into depth, [the repeating background elements] pulling away. Constant lens height, no pan, no tilt, no handheld drift; the two motions start and end together.
```

### Rack focus
```
The camera hard-locked on a tripod with no pan, no tilt, no push, no drift; the only optical change is FOCUS. Hold sharp on [plane A — the far anchor]; then rack once to [plane B — the near subject]; then follow focus on the subject if they move toward the lens. Speed: the rack is slow, smooth and continuous with no hunting and no overshoot; the follow focus tracks without breathing. Framing: the composition never changes; exactly one plane is sharp at any moment, the other melts into clean bokeh; the subject grows in frame only by physically approaching the lens. End: settle sharp on [the final subject framing], the far plane dissolved to soft bokeh behind.
```


## Aerial & crane

### Crane up
```
A smooth jib rise from [1.2] meters to [9] meters altitude over the shot, with a gentle continuous downward tilt that keeps the subject anchored in [the lower third] of frame as the world opens above and around them. No lateral orbit, no truck, no zoom, no speed ramps; one continuous vertical reveal easing into a high hold.
```

### Drone orbit
```
A smooth constant-speed circular drone flight around the subject — [8]-meter radius, [4]-meter altitude, traveling screen-[right] (clockwise seen from above), covering roughly a [200]-degree arc across the shot. The horizon rotates continuously behind the subject; no altitude change, no radius drift, no zoom, no speed ramps.
```

### Aerial pullback
```
The camera starts [2.5] meters ahead of the subject at [3] meters altitude and flies backward and upward along the axis in one continuous accelerating move, reaching about [40] meters distance and [25] meters altitude by the end. The subject stays centered, then the whole [craft / scene] centers itself in frame as it shrinks; the horizon line rises steadily through the frame. No orbit, no zoom, no speed reversals.
```


## Dolly & tracking

### Dolly in
```
One continuous decisive dolly in on straight ground rails — pure forward travel at constant speed along the axis toward the subject, at a locked constant lens height of [1.5] meters, decelerating smoothly into a static hold at the end framing. The field of view never changes — no zoom: the perspective shifts because the camera physically approaches, near objects sweeping out past the frame edges with strong parallax. No pan, no tilt, no crane, no handheld drift; dead-level travel from first frame to last.
```

### Tracking
```
One continuous lateral tracking move — the camera glides parallel to the subject at exactly the speed that keeps their framing constant, strict 90-degree side view at all times. Three clean parallax layers: nearest — [posts / mullions / table edges] sweeping fast past the lens, briefly occluding the subject; middle — the subject, constant size at frame center; farthest — [the background row] sliding by slower behind. No zoom, no pan drift, no push-in.
```

### Push in
```
A slow continuous creeping forward drift from [7] meters to [2] meters over the full shot — gimbal-smooth floating advance at [1.5]-meter height with barely perceptible organic sway, no rails feel, no speed changes, no zoom, no pan, no tilt. The approach should feel like held breath, decelerating into a near-stop at the end framing.
```


## Specialty

### Handheld
```
Raw handheld shoulder-rig throughout — visible shake, operator breathing, rolling horizon, imperfect reframes that always recover. Path: [opening angle] → [rough half-circle drift around the subject] → [lean-in to close-up] → [loose pull-back and hold]. Never stabilized, no gimbal float, no rails feel.
```

### POV
```
The camera is a person's eyes at [1.7]-meter height walking forward from [the start point] to [the end mark]. Natural human walking cadence — gentle vertical bob synced to the steps, slight lateral sway, small organic head micro-rotations glancing around the space. The person's hands appear in frame only for [the interaction], then drop out of frame. The walk stops when [the trigger event].
```

### 360 orbit
```
One continuous 360-degree orbit — the camera travels a full circle around the subject on a locked constant radius of [2.5] meters at a locked constant height, panning continuously to keep the subject dead-center at constant size, one full revolution in ONE direction at one constant angular speed, returning exactly to the opening framing at the end. The subject stays planted, facing one fixed direction in the world the entire time — it is the camera that circles them; the background streams continuously through the full compass behind their shoulders. No radius drift, no height drift, no speed changes, no reversal, no turntable effect where the subject spins in place.
```

### Bullet time
```
Bullet time orbit: time inside the scene slams to a near-freeze — the subject hangs suspended mid-action, with droplets, debris and particles locked motionless in mid-air, every suspended object holding its exact position and angle with zero drift — while the camera alone keeps moving at normal speed, sweeping along a smooth circular arc around the frozen moment. The camera's travel through the curve is fluid, constant and unaffected by the stopped world. Distance to the subject and camera height stay fixed; the suspended figure remains centered, sharp and fully readable as the perspective wheels around them and the background rotates past. The orbit settles on a striking new angle of the frozen instant and holds that composition before time is released again.
```


## Zoom & focus

### Crush zoom
```
Camera locked on a tripod — a perfectly static hold on the tight [18]-degree frame, then a violent optical crash zoom OUT — about 0.4 seconds, zoom-ring only, with real motion blur and a hard stop — landing on a locked wide [84]-degree frame held perfectly static to the end. No dolly, no handheld, no speed ramps; the camera position never moves, only the field of view changes, and there is no parallax.
```


## Specialty

### Robot arm
```
The camera flies one fast, perfectly smooth stabilized motion-control path through four positions — [front eye-level medium close-up] → [side arc at eye level] → [sinking into a low angle with a slight dutch tilt] → [craning up and over into a top-down 3/4 view]. Each glide takes about [1] second with soft ease-in/out and brief readable holds at every position; machined gimbal/crane quality — no shake, no whip pans, no speed ramps, no motion blur.
```

### Body-mounted camera: Snorricam
```
A rigid chest-mounted rig facing back at the subject — their face and torso locked to the frame center for the entire shot, unable to leave it; the subject's walk transfers to the WORLD as a slow gentle bob and sway, [the background elements] gliding past behind their shoulders, never lurching. No stabilization beyond the rig's rigidity, no independent camera motion, no zoom.
```

### Timelapse
```
A single slow, perfectly smooth constant pull-back, the frame gradually widening — no shake, no orbit, no speed changes, no zoom substitution. Two speeds of time in one frame: the world runs in time-lapse — [day → night → morning → rainy twilight → day], smooth in-frame light morphs — while the subject moves in real time at normal human speed.
```


## Dolly & tracking

### Chase shot
```
Sweep the camera in toward the running subject, then follow them handheld across [the terrain], lurching and shaking with each impact. Speed: fast and unstable, with sharp jolts on every [tremor / collision], imperfect reframes that always recover the subject. Framing: keep the subject in frame while [the hazards] enter and pass through it. End: the shake eases; settle on a clear final composition.
```

### Truck right
```
One continuous truck right — pure lateral travel of the camera to the right at constant speed with the lens axis locked straight ahead, no panning to compensate: the scene slides through the frame with strong natural parallax, near objects sweeping past fast, the far layer drifting slow, the subject crossing gradually toward the left frame edge. No pan, no arc, no dolly, no zoom, no handheld drift; the lens points the same world direction in the first and last frame.
```

### Low tracking
```
Extreme slow motion throughout — a ~1000fps look with no speed ramps and no real-time moments — the camera at ground height below knee level the entire time: a smooth lateral track gliding alongside the subject at slow-mo pace, strict side view, never rising, never tilting up, no push, no orbit, no zoom. The track never stops: the shot ends mid-motion on a live frame — no cut to black, no fade, no freeze.
```


## Pan & tilt

### Pan left
```
The camera body is locked on the fixed tripod at [lens height]; the only motion is one smooth continuous horizontal rotation LEFT of about [90] degrees across the full shot — no travel, no dolly, no truck, no arc, no zoom, no tilt. Constant unhurried rotational speed with a gentle settle in the final half second, timed so the landing composition and [the landing event] arrive together. The horizon stays level throughout; new space enters from the left frame edge only through rotation. End: settle on a clear final composition and hold.
```

### Pedestal down
```
The whole camera body sinks straight down along a clean vertical line from lens height [2.2] to [0.8] meters. The descent runs at an even, fluid, uninterrupted rate. Throughout the lowering, the lens stays perfectly horizontal and locked on its original heading — no tilting, no turning, no crane arc, no dolly, no zoom: the horizon holds its exact angle while the framing slides down the subject like an elevator window. The camera's horizontal position is identical in the first and last frame; the move comes to rest with the new lower vantage clearly established and easy to read.
```

### Pedestal up
```
The entire camera ascends straight upward along a pure vertical path from lens height [0.8] to [2.2] meters. The lift proceeds at a steady, seamless, constant pace from bottom to top. While climbing, the lens holds dead level and keeps facing its original direction — no tilt creeps in, no rotation, no crane arc, no dolly, no zoom: the horizon holds its exact angle while the framing slides up the subject like an elevator window. The camera's horizontal position is identical in the first and last frame; the motion settles with the elevated viewpoint plainly legible in the final frame.
```


## Dolly & tracking

### Slider left
```
The camera eases sideways over a compact distance — about [40] centimeters — riding a smooth slider track toward the left, the lens axis locked straight ahead, with a soft ease-in and ease-out at both ends. Its pace is deliberately slow, held constant, and under full control at every moment. During the travel the depth planes separate cleanly — near objects, the central subject and the distant background each sliding at distinct rates, keeping the parallax legible. The travel never exceeds the slider's short throw — no pan, no zoom, no full truck, no handheld drift. The move closes on an elegant, resolved frame where the newly gained left-hand angle reads clearly.
```


## Zoom & focus

### Fast zoom in
```
Locked tripod, zero rotation, zero travel — the entire move is optical. Hold the wide [84]-degree frame perfectly static; then ONE sharp continuous zoom from [84] degrees to [18] degrees — a single decisive ramp of about 1.2 seconds with no steps and no wobble, flying the framing from [the wide composition] to [the tight landing framing]; then hold the tight frame perfectly static to the end. The camera position is fixed and never moves; only the field of view changes; perspective stays constant and there is no parallax.
```

### Fast zoom out
```
Locked tripod, zero rotation, zero travel — the entire move is optical. Hold the tight [18]-degree frame perfectly static; then ONE sharp continuous zoom out from [18] degrees to [84] degrees — a single decisive ramp of about 1.2 seconds with no steps, no wobble and no overshoot, blowing the framing open from [the tight composition] to [the wide landing framing]; then hold the wide frame perfectly static to the end. The camera position is fixed and never moves; only the field of view changes; perspective stays constant and there is no parallax.
```


## Pan & tilt

### Tilt down
```
One slow continuous tilt down — a pure vertical rotation on the locked tripod head from [+35] degrees to [-10] degrees — traveling from [the upper anchor], along [the mid-path detail], down to [the lower landing framing]. No crane rise, no pedestal, no dolly, no truck, no zoom, no horizontal drift; the camera's position never changes, and the tilt decelerates into a static hold on the final framing.
```


## Dolly & tracking

### Push past
```
One continuous forward travel on a lane offset about 0.6 meters to the subject's right — the camera approaches at constant speed and constant height, the subject growing in frame, then slides past their shoulder: the subject exits cleanly at the left frame edge while the camera continues WITHOUT stopping toward the reveal beyond, focus racking from the subject to the far point at the moment of the pass. The camera passes BESIDE the subject, never through them, never stopping at them. No pan correction, no zoom, no tilt.
```

### Follow shot
```
A follow shot locked 0.8 meters behind the subject's shoulder for the entire take, matching their walking speed exactly, the back of the head and near shoulder anchored in soft near focus in the left third of frame, the focus plane locked at depth down the axis ahead; a gentle organic bob transmitted from the stride — no stabilizer glide, no handheld chaos, no overtaking, no pan away.
```

### Arc right
```
One continuous arc right — the camera travels along a circular path around the subject through about [60] degrees on a locked constant radius of [2.5] meters at a locked constant height, panning continuously to keep the subject dead-center at constant size while the background sweeps behind them. Travel through the arc is calm, even and precisely controlled; the subject stays planted, facing one fixed direction in the world — it is the camera that travels. No radius drift, no height change, no zoom, no turntable effect where the subject rotates in place. The path concludes at a fresh right-side perspective.
```

### Dolly out
```
One continuous decisive dolly out on straight ground rails — pure rearward travel at constant confident speed along the axis, at a locked constant lens height of [1.6] meters. The camera NEVER rises: no crane, no jib, no pedestal up, no drone pull-away, no gain in altitude of any kind; the lens stays dead-level with zero tilt, so [a fixed horizontal edge of the set — table edge, balustrade rail] holds the exact same height in frame from the first frame to the last. Near objects sweep past the frame edges close and fast with strong parallax while the subject recedes at the center. No zoom, no pan, no handheld drift.
```


## Pan & tilt

### Whip pan left
```
The camera holds composition A perfectly static, then executes ONE violent horizontal whip pan to the left — a 0.4-second full-blur smear — landing hard on composition B with a 2-degree overshoot-and-settle, then holds composition B perfectly static. No dolly, no truck, no crane, no handheld drift; a pure rotation between two directed static frames.
```

### Whip pan right
```
The camera holds composition A perfectly static on the tripod, then executes ONE violent horizontal whip pan to the right — a 0.4-second full-blur smear — landing hard on composition B with a 2-degree overshoot-and-settle, then holds composition B perfectly static. No dolly, no truck, no crane, no handheld drift; a pure rotation between two directed static frames.
```


## Zoom & focus

### Slow zoom out
```
Locked tripod bolted in place, zero rotation, zero travel — the entire move is inside the lens: a purely OPTICAL zoom out, a focal-length pull from telephoto to wide on a stationary camera, exactly like a photographer standing in one spot and slowly turning the zoom ring. One single perfectly even continuous zoom from [18] degrees to [84] degrees across the entire duration, no speed changes, no steps, no drift. NOT a dolly out, NOT a pull-back, NOT a track backward — no rearward travel, no crane, no jib, no pedestal, no drone pull-away, no floating retreat; the camera's position and height are identical in the first and last frame. ZERO parallax: the far background keeps the exact same apparent size relative to the subject from the first frame to the last, and new space enters the picture only at the frame edges as the view opens.
```


## Dolly & tracking

### Reverse tracking: Walk-and-talk
```
One continuous reverse tracking move — the camera travels backward at exactly the subject's walking speed for the entire take, keeping their size in frame perfectly constant while the world flows past them toward the camera on both edges. No pan, no tilt, no zoom, no speed changes; the eyeline stays just above the lens. Fixed 47-degree normal field of view; focus locked on the face; [the passing elements and hands] flowing past read soft at the frame edges.
```

### Arc left
```
One continuous arc left — the camera sweeps along a circular path around the subject through about [60] degrees on a locked constant radius of [2.5] meters at a locked constant height, panning continuously to keep the subject dead-center at constant size while the background sweeps behind them. The pace through the bend is even, calm and deliberate; the subject stays planted, facing one fixed direction in the world — it is the camera that travels. No radius drift, no height change, no zoom, no turntable effect where the subject rotates in place. The arc resolves on a fresh vantage point taken from the left.
```

### Slider right
```
The camera eases sideways over a compact distance — about [40] centimeters — riding a smooth slider track toward the right, the lens axis locked straight ahead, with a soft ease-in and ease-out at both ends. Its pace is deliberately slow, held constant, and under full control at every moment. During the travel the depth planes separate cleanly — near objects, the central subject and the distant background each sliding at distinct rates, keeping the parallax legible. The travel never exceeds the slider's short throw — no pan, no zoom, no full truck, no handheld drift. The move closes on an elegant, resolved frame where the newly gained right-hand angle reads clearly.
```

### Vehicle tracking
```
The camera travels in tandem with the [vehicle], following the same route it takes. Velocity is synced precisely to the vehicle's own speed — no drifting ahead, no falling behind, no independent motion. Locked to that shared motion, the vehicle sits steady and anchored at a constant size in frame while the road surface, markings and roadside scenery rush past in a continuous flow on every parallax layer. No zoom, no pan drift; the shot ends holding that stable, unmistakable image of the machine in motion.
```


## Aerial & crane

### Drone push in
```
Skim the camera low and fast over [the terrain] straight toward [the target] with gentle left-right banking, climb along [the slope / the obstacle], then pitch up hard and track [the rising subject] as it sweeps directly overhead. Speed: fast from the start, ramping to full throttle on the approach, with real flight inertia, no instant direction changes. Framing: keep [the target] centered ahead while the ground rushes under the lens; [the rising subject] grows to fill the frame as it passes over. End: settle on [the final composition] and hold.
```


## Dolly & tracking

### Truck left
```
One continuous truck left — pure lateral travel of the camera to the left at constant speed with the lens axis locked straight ahead, no panning to compensate: the scene slides through the frame with strong natural parallax, near objects sweeping past fast, the far layer drifting slow, the subject crossing gradually toward the right frame edge. No pan, no arc, no dolly, no zoom, no handheld drift; the lens points the same world direction in the first and last frame.
```


## Aerial & crane

### Helicopter shot
```
Arc the camera in a slow counter-clockwise orbit around the scene from a distance, like a stabilized news gimbal panning and tilting to follow [the subject] with slight operator overshoots and corrections — then punch in with one fast snap-zoom onto [the detail]; a zoom within the same take, not a cut. Speed: slow steady orbit with fine vibration and micro-drift; the snap-zoom is abrupt, overshoots slightly, hunts focus for a beat, then locks. Framing: long-lens telephoto look, [the scene planes] stacked in one compressed composition through haze; after the zoom, tight on [the detail] only. End: hold tight on [the detail]; the frame jolts at [the impact], damps, and settles while still faintly trembling.
```

### Crane down
```
Descend the camera vertically from a high fixed point, facing [the target] the whole way, the tilt easing from a steep down-angle to eye level; [if the world itself moves — a rolling ship, a swaying platform — the whole frame inherits that motion and never auto-levels]. Speed: brief hold at the top, then smooth constant descent with a soft ease-out at the bottom. Framing: keep [the target] centered and growing in frame. End: settle at eye level on [the final composition] and hold.
```
