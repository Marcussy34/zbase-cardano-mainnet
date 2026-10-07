import { useEffect, useRef } from "react";
import { SOFFIT_CONFIG, SOFFIT_FRAGMENT, SOFFIT_VERTEX } from "./soffit-shader";

export default function SoffitBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const panel = canvas?.closest<HTMLElement>(".overview-panel");
    const site = canvas?.closest<HTMLElement>(".site");
    if (!canvas || !panel || !site) return;
    canvas.dataset.ready = "false";
    if (typeof WebGL2RenderingContext === "undefined"
      || typeof IntersectionObserver === "undefined"
      || typeof ResizeObserver === "undefined"
      || typeof MutationObserver === "undefined"
      || typeof requestAnimationFrame !== "function"
      || typeof cancelAnimationFrame !== "function"
      || typeof matchMedia !== "function") return;

    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    if (typeof reducedMotion.addEventListener !== "function"
      || typeof reducedMotion.removeEventListener !== "function") return;

    let gl: WebGL2RenderingContext | null;
    try {
      gl = canvas.getContext("webgl2", {
        alpha: false, antialias: false, depth: false, stencil: false,
        powerPreference: "high-performance",
      });
    } catch {
      return;
    }
    if (!gl) return;
    const context = gl;
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null;
    let vertexArray: WebGLVertexArrayObject | null = null;
    const release = () => {
      context.useProgram(null);
      context.bindVertexArray(null);
      shaders.forEach((shader) => context.deleteShader(shader));
      if (vertexArray) context.deleteVertexArray(vertexArray);
      if (program) context.deleteProgram(program);
    };
    const compile = (type: number, source: string) => {
      const shader = context.createShader(type);
      if (!shader) throw new Error("Soffit shader unavailable");
      shaders.push(shader);
      context.shaderSource(shader, source);
      context.compileShader(shader);
      if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
        throw new Error("Soffit shader could not compile");
      }
      return shader;
    };

    try {
      const vertex = compile(context.VERTEX_SHADER, SOFFIT_VERTEX);
      const fragment = compile(context.FRAGMENT_SHADER, SOFFIT_FRAGMENT);
      program = context.createProgram();
      if (!program) throw new Error("Soffit program unavailable");
      context.attachShader(program, vertex);
      context.attachShader(program, fragment);
      context.linkProgram(program);
      if (!context.getProgramParameter(program, context.LINK_STATUS)) {
        throw new Error("Soffit program could not link");
      }
      vertexArray = context.createVertexArray();
      if (!vertexArray) throw new Error("Soffit vertex array unavailable");
      context.useProgram(program);
      context.bindVertexArray(vertexArray);
    } catch {
      release();
      return;
    }

    const locations = new Map<string, WebGLUniformLocation | null>();
    const location = (name: string) => {
      if (!locations.has(name)) locations.set(name, context.getUniformLocation(program!, name));
      return locations.get(name)!;
    };
    Object.entries(SOFFIT_CONFIG).forEach(([key, value]) => {
      if (key === "cursor" || key === "maxDpr") return;
      const name = key === "bgColor" ? "uBg" : `u${key[0].toUpperCase()}${key.slice(1)}`;
      if (typeof value === "string") {
        const hex = Number.parseInt(value.slice(1), 16);
        context.uniform3f(location(name), ((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
      } else context.uniform1f(location(name), value);
    });

    let inView = false;
    let ready = false;
    let lost = false;
    let disposed = false;
    let frameId: number | null = null;
    let previousTime: number | null = null;
    let clock = 0;
    let resizePending = true;
    const mouse = { x: 0, y: 0, ax: 0, ay: 0, tx: 0, ty: 0 };
    const canAnimate = () => !disposed && !lost && inView && !document.hidden
      && !reducedMotion.matches && site.dataset.motion === "active";

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, SOFFIT_CONFIG.maxDpr);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.viewport(0, 0, width, height);
      context.uniform2f(location("iResolution"), width, height);
      resizePending = false;
    };
    const draw = () => {
      if (disposed || lost) return;
      if (resizePending) resize();
      context.uniform1f(location("iTime"), clock);
      context.uniform2f(location("iMouse"), mouse.x, mouse.y);
      context.drawArrays(context.TRIANGLES, 0, 3);
      if (!ready) {
        canvas.dataset.ready = "true";
        ready = true;
      }
    };
    const stop = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      previousTime = null;
    };
    const frame = (now: number) => {
      frameId = null;
      if (!canAnimate()) { previousTime = null; return; }
      // A resumed frame starts from rest instead of consuming time spent paused.
      if (previousTime !== null) {
        const milliseconds = Math.min(50, Math.max(4.167, now - previousTime));
        const step = Math.min(2.2, milliseconds * 0.06);
        clock += milliseconds * 0.001;
        mouse.ax += (mouse.tx - mouse.ax) * 0.105 * step;
        mouse.ay += (mouse.ty - mouse.ay) * 0.105 * step;
        mouse.x += (mouse.ax - mouse.x) * 0.043 * step;
        mouse.y += (mouse.ay - mouse.y) * 0.043 * step;
      }
      previousTime = now;
      draw();
      frameId = requestAnimationFrame(frame);
    };
    const synchronize = () => {
      if (!canAnimate()) {
        stop();
        if (resizePending && inView && !document.hidden) draw();
      }
      else if (frameId === null) frameId = requestAnimationFrame(frame);
    };
    const aim = (event: PointerEvent) => {
      if (!canAnimate() || !SOFFIT_CONFIG.cursor) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.height <= 0) return;
      mouse.tx = (event.clientX - rect.left - rect.width / 2) / rect.height;
      mouse.ty = (rect.height / 2 - (event.clientY - rect.top)) / rect.height;
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      lost = true;
      ready = false;
      canvas.dataset.ready = "false";
      stop();
    };

    const intersection = new IntersectionObserver((entries) => {
      inView = entries.some((entry) => entry.isIntersecting);
      synchronize();
    }, { threshold: 0 });
    const size = new ResizeObserver(() => {
      resizePending = true;
      // Paused backgrounds still fit their panel without starting a render loop.
      if (frameId === null && inView && !document.hidden) draw();
    });
    const motion = new MutationObserver(synchronize);
    intersection.observe(canvas);
    size.observe(canvas);
    motion.observe(site, { attributes: true, attributeFilter: ["data-motion"] });
    reducedMotion.addEventListener("change", synchronize);
    document.addEventListener("visibilitychange", synchronize);
    panel.addEventListener("pointermove", aim, { passive: true });
    panel.addEventListener("pointerdown", aim, { passive: true });
    canvas.addEventListener("webglcontextlost", contextLost);
    draw();

    return () => {
      disposed = true;
      stop();
      intersection.disconnect();
      size.disconnect();
      motion.disconnect();
      reducedMotion.removeEventListener("change", synchronize);
      document.removeEventListener("visibilitychange", synchronize);
      panel.removeEventListener("pointermove", aim);
      panel.removeEventListener("pointerdown", aim);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.dataset.ready = "false";
      release();
    };
  }, []);

  return <canvas ref={canvasRef} className="soffit-canvas" aria-hidden="true" data-ready="false" />;
}
