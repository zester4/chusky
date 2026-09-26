import { useEffect, useRef } from 'react'

/**
 * Minimal 2D canvas game shell for TanStack Start / React routes.
 * Copy into your routes tree, then replace the update/draw bodies with the genre loop.
 * For WASD vehicles/flight, load the `controls` skill before changing input signs.
 */
export function GameCanvas() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const keys = new Set<string>()
    const onDown = (e: KeyboardEvent) => {
      keys.add(e.code)
      if (e.code === 'KeyR') restart()
    }
    const onUp = (e: KeyboardEvent) => keys.delete(e.code)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)

    let score = 0
    let alive = true
    let last = performance.now()
    const player = { x: 240, y: 160, r: 12, speed: 180 }
    const coin = { x: 100, y: 80, r: 8 }
    const scoreEl = () => document.getElementById('game-score')
    const statusEl = () => document.getElementById('game-status')

    function placeCoin() {
      coin.x = 30 + Math.random() * (canvas!.width - 60)
      coin.y = 30 + Math.random() * (canvas!.height - 60)
    }

    function restart() {
      score = 0
      alive = true
      player.x = 240
      player.y = 160
      placeCoin()
      if (scoreEl()) scoreEl()!.textContent = '0'
      if (statusEl()) statusEl()!.textContent = 'playing'
    }

    function update(dt: number) {
      if (!alive) return
      let dx = 0
      let dy = 0
      if (keys.has('ArrowLeft') || keys.has('KeyA')) dx -= 1
      if (keys.has('ArrowRight') || keys.has('KeyD')) dx += 1
      if (keys.has('ArrowUp') || keys.has('KeyW')) dy -= 1
      if (keys.has('ArrowDown') || keys.has('KeyS')) dy += 1
      if (dx || dy) {
        const len = Math.hypot(dx, dy) || 1
        player.x += (dx / len) * player.speed * dt
        player.y += (dy / len) * player.speed * dt
        player.x = Math.max(player.r, Math.min(canvas!.width - player.r, player.x))
        player.y = Math.max(player.r, Math.min(canvas!.height - player.r, player.y))
      }
      if (Math.hypot(player.x - coin.x, player.y - coin.y) < player.r + coin.r) {
        score += 1
        if (scoreEl()) scoreEl()!.textContent = String(score)
        placeCoin()
      }
    }

    function draw() {
      ctx!.fillStyle = '#111827'
      ctx!.fillRect(0, 0, canvas!.width, canvas!.height)
      ctx!.fillStyle = '#fbbf24'
      ctx!.beginPath()
      ctx!.arc(coin.x, coin.y, coin.r, 0, Math.PI * 2)
      ctx!.fill()
      ctx!.fillStyle = alive ? '#38bdf8' : '#f87171'
      ctx!.beginPath()
      ctx!.arc(player.x, player.y, player.r, 0, Math.PI * 2)
      ctx!.fill()
    }

    let raf = 0
    function frame(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      update(dt)
      draw()
      raf = requestAnimationFrame(frame)
    }

    placeCoin()
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])

  return (
    <div style={{ display: 'grid', gap: 8, justifyItems: 'center' }}>
      <div style={{ fontSize: 14, opacity: 0.9 }}>
        Score: <span id="game-score">0</span> · <span id="game-status">playing</span>
      </div>
      <canvas
        ref={ref}
        width={480}
        height={320}
        style={{
          background: '#111827',
          border: '2px solid #334155',
          borderRadius: 8,
          imageRendering: 'pixelated',
          maxWidth: '100%',
        }}
      />
      <div style={{ fontSize: 12, opacity: 0.6 }}>
        Arrows / WASD · R restart · swap loop for your genre
      </div>
    </div>
  )
}
