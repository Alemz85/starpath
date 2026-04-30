'use client'

// Celestial Sphere — WebGL fragment shader rendering a slowly drifting
// nebula plus a sparse starfield, with cursor-driven warp. Adapted
// from the 21st.dev component, retuned to starpath:
//   - default hue is the galaxy violet axis (285°), not generic blue
//   - default speed is slower (0.18 vs 0.3 source) so it reads as
//     ambient atmosphere, not a screensaver
//   - particle size reduced so stars are tiny pinpoints, not blobs
//   - mouse handler is scoped to the container's bounding rect so the
//     warp follows the cursor inside our app window, not the whole
//     desktop monitor (the source used global mousemove)
//
// Mounted behind .galaxy-immersive on OnboardingGate as a richer
// backdrop. Cleans up its WebGL context on unmount.

import { useEffect, useRef } from 'react'
import * as THREE from 'three'

interface CelestialSphereProps {
  /** HSL hue in degrees. 285 = galaxy violet (default). */
  hue?: number
  /** Time multiplier. Lower = slower drift. */
  speed?: number
  /** Shader space zoom. Higher = wider field of view. */
  zoom?: number
  /** Star pinpoint brightness factor. */
  particleSize?: number
  className?: string
}

export function CelestialSphere({
  hue = 285,
  speed = 0.18,
  zoom = 1.4,
  particleSize = 2.5,
  className = 'w-full h-full',
}: CelestialSphereProps) {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)

    const vertexShader = `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `

    const fragmentShader = `
      precision highp float;
      varying vec2 vUv;
      uniform vec2 u_resolution;
      uniform float u_time;
      uniform vec2 u_mouse;
      uniform float u_hue;
      uniform float u_zoom;
      uniform float u_particle_size;

      vec3 hsl2rgb(vec3 c) {
        vec3 rgb = clamp(abs(mod(c.x*6.0+vec3(0.0,4.0,2.0), 6.0)-3.0)-1.0, 0.0, 1.0);
        return c.z * mix(vec3(1.0), rgb, c.y);
      }
      float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
      }
      float noise(vec2 st) {
        vec2 i = floor(st);
        vec2 f = fract(st);
        float a = random(i);
        float b = random(i + vec2(1.0, 0.0));
        float c = random(i + vec2(0.0, 1.0));
        float d = random(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.y * u.x;
      }
      float fbm(vec2 st) {
        float value = 0.0;
        float amplitude = 0.5;
        for (int i = 0; i < 6; i++) {
          value += amplitude * noise(st);
          st *= 2.0;
          amplitude *= 0.5;
        }
        return value;
      }

      void main() {
        vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.y, u_resolution.x);
        uv *= u_zoom;
        vec2 mouse_normalized = u_mouse / u_resolution;
        uv += (mouse_normalized - 0.5) * 0.5;

        float f = fbm(uv + vec2(u_time * 0.1, u_time * 0.05));
        float t = fbm(uv + f + vec2(u_time * 0.05, u_time * 0.02));

        float nebula = pow(t, 2.0);
        vec3 color = hsl2rgb(vec3(u_hue / 360.0 + nebula * 0.18, 0.7, 0.45));
        color *= nebula * 2.2;

        float star_val = random(vUv * 500.0);
        if (star_val > 0.9985) {
            float star_brightness = (star_val - 0.9985) / 0.0015;
            color += vec3(star_brightness * u_particle_size);
        }

        gl_FragColor = vec4(color, 1.0);
      }
    `

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        u_time: { value: 0 },
        u_resolution: { value: new THREE.Vector2() },
        u_mouse: { value: new THREE.Vector2() },
        u_hue: { value: hue },
        u_zoom: { value: zoom },
        u_particle_size: { value: particleSize },
      },
    })

    const geometry = new THREE.PlaneGeometry(2, 2)
    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)

    const resize = () => {
      const w = mount.clientWidth || window.innerWidth
      const h = mount.clientHeight || window.innerHeight
      renderer.setSize(w, h)
      material.uniforms.u_resolution.value.set(w, h)
    }
    resize()

    const onMouseMove = (event: MouseEvent) => {
      const rect = mount.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      material.uniforms.u_mouse.value.set(x, mount.clientHeight - y)
    }

    let raf = 0
    const animate = () => {
      material.uniforms.u_time.value += 0.005 * speed
      renderer.render(scene, camera)
      raf = requestAnimationFrame(animate)
    }

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (!reduced) {
      animate()
    } else {
      // Render one frame so a static nebula is visible without animating.
      renderer.render(scene, camera)
    }

    window.addEventListener('resize', resize)
    window.addEventListener('mousemove', onMouseMove)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMouseMove)
      if (mount && renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
      geometry.dispose()
      material.dispose()
      renderer.dispose()
    }
  }, [hue, speed, zoom, particleSize])

  return <div ref={mountRef} className={className} aria-hidden />
}
