(() => {
  'use strict';

  const CUSTOM_SHAPES = Object.freeze({
    triLine: { name: 'Tromino Line', color: '#22d3ee', cells: 3, matrix: [[1, 1, 1]] },
    triCorner: { name: 'Tromino Corner', color: '#2dd4bf', cells: 3, matrix: [[1, 0], [1, 1]] },
    pentP: { name: 'Pentomino P', color: '#fb7185', cells: 5, matrix: [[1, 1], [1, 1], [1, 0]] },
    plus: { name: 'Plus', color: '#f0abfc', cells: 5, matrix: [[0, 1, 0], [1, 1, 1], [0, 1, 0]] },
    corner: { name: 'Corner', color: '#fbbf24', cells: 5, matrix: [[1, 0, 0], [1, 0, 0], [1, 1, 1]] },
    fiveLine: { name: '5×1 Line', color: '#38bdf8', cells: 5, matrix: [[1, 1, 1, 1, 1]] },
    basket: { name: 'U-Basket', color: '#a78bfa', cells: 5, matrix: [[1, 0, 1], [1, 1, 1]] }
  });

  class GameEngine {
    constructor(update) {
      this.lastTime = 0;
      this.update = update;
    }

    reset(timestamp = 0) {
      this.lastTime = timestamp;
    }

    advance(timestamp) {
      const delta = this.lastTime ? Math.min(100, Math.max(0, timestamp - this.lastTime)) : 0;
      this.lastTime = timestamp;
      this.update(delta, timestamp);
    }
  }

  class ShapeFactory {
    constructor(definitions = CUSTOM_SHAPES) {
      this.definitions = definitions;
      this.types = Object.keys(definitions);
      this.lastMorph = -1;
    }

    create(type) {
      const shape = this.definitions[type];
      if (!shape) return null;
      return {
        type,
        matrix: shape.matrix.map((row) => row.slice()),
        color: shape.color,
        orientation: 0,
        special: null,
        specialCell: null,
        custom: true
      };
    }

    morph(currentType, rng) {
      if (this.types.length < 2) return null;
      let index = Math.floor(rng() * this.types.length);
      if (this.types[index] === currentType) index = (index + 1) % this.types.length;
      this.lastMorph = index;
      return this.create(this.types[index]);
    }

    kicksFor(size) {
      if (size <= 3) return [[0, 0], [-1, 0], [1, 0], [0, -1], [-1, -1], [1, -1], [0, 1]];
      return [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [-1, -1], [1, -1], [0, -2], [-1, -2], [1, -2], [0, 1]];
    }

    static isCustom(type) {
      return Object.prototype.hasOwnProperty.call(CUSTOM_SHAPES, type);
    }
  }

  class Renderer {
    constructor() {
      this.gradients = new WeakMap();
    }

    invalidate(context) {
      this.gradients.delete(context);
    }

    cellGradient(context, x, y, size, fill, texture, ratio) {
      let cache = this.gradients.get(context);
      if (!cache) {
        cache = new Map();
        this.gradients.set(context, cache);
      }
      const key = `${x}:${y}:${size}:${fill}:${texture}:${ratio}`;
      let gradient = cache.get(key);
      if (gradient) return gradient;
      gradient = context.createLinearGradient(x, y, x + size, y + size);
      gradient.addColorStop(0, texture === 'metallic' ? '#f8fafc' : '#ffffff');
      gradient.addColorStop(0.18, fill);
      gradient.addColorStop(0.55, texture === 'metallic' ? '#94a3b8' : fill);
      gradient.addColorStop(1, texture === 'gems' ? '#172554' : texture === 'metallic' ? '#334155' : fill);
      if (cache.size >= 5000) cache.clear();
      cache.set(key, gradient);
      return gradient;
    }

    initializePlayer(player) {
      player.particles = Array.from({ length: 180 }, () => ({
        active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, size: 0, color: ''
      }));
      player.particleCount = 0;
      player.floatingText = Array.from({ length: 12 }, () => ({
        active: false, text: '', color: '', age: 0, life: 0, x: 0, y: 0
      }));
      player.floatingTextCount = 0;
      player.ripples = Array.from({ length: 10 }, () => ({
        active: false, x: 0, y: 0, age: 0, life: 0, color: ''
      }));
      player.rippleCount = 0;
    }

    resetPlayer(player) {
      player.particleCount = 0;
      player.floatingTextCount = 0;
      player.rippleCount = 0;
      for (let index = 0; index < player.particles.length; index++) player.particles[index].active = false;
      for (let index = 0; index < player.floatingText.length; index++) player.floatingText[index].active = false;
      for (let index = 0; index < player.ripples.length; index++) player.ripples[index].active = false;
    }

    acquire(pool) {
      for (let index = 0; index < pool.length; index++) {
        const item = pool[index];
        if (!item.active) {
          item.active = true;
          return item;
        }
      }
      pool[0].active = true;
      return pool[0];
    }
  }

  class InputHandler {
    constructor(dispatch) {
      this.dispatchAction = dispatch;
    }

    dispatch(playerId, action, fromReplay = false) {
      this.dispatchAction(playerId, action, fromReplay);
    }

    static vibrate(pattern) {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
    }
  }

  class AchievementManager {
    constructor({ load, save, toast, chime }) {
      this.load = load;
      this.save = save;
      this.toast = toast;
      this.chime = chime;
      this.queue = [];
      this.showing = false;
    }

    flush() {
      const name = this.queue.shift();
      if (!name) {
        this.showing = false;
        return;
      }
      this.showing = true;
      this.toast(`🏆 Trophy unlocked: ${name}`, 'success');
      this.chime();
      setTimeout(() => {
        this.showing = false;
        this.flush();
      }, 340);
    }

    unlock(id, achievement, condition) {
      const unlocked = this.load();
      if (unlocked[id] || !achievement || !condition()) return false;
      unlocked[id] = { unlockedAt: Date.now() };
      if (!this.save(unlocked)) return false;
      this.queue.push(achievement.name);
      if (!this.showing) this.flush();
      return true;
    }
  }

  class AudioEngine {
    constructor(playTone) {
      this.playTone = playTone;
    }

    play(name) {
      const cues = {
        unlock: { frequency: 740, duration: 0.2, type: 'triangle', volume: 0.08, slideTo: 1180 },
        morph: { frequency: 620, duration: 0.2, type: 'triangle', volume: 0.08, slideTo: 1120 }
      };
      if (cues[name]) this.playTone(cues[name]);
    }
  }

  class UIController {
    constructor(documentRef) {
      this.document = documentRef;
    }

    show(id) {
      const modal = this.document.getElementById(id);
      if (modal) modal.classList.remove('hidden');
    }

    hide(id) {
      const modal = this.document.getElementById(id);
      if (modal) modal.classList.add('hidden');
    }
  }

  window.NeonArcade = Object.freeze({
    AchievementManager,
    AudioEngine,
    CUSTOM_SHAPES,
    GameEngine,
    InputHandler,
    Renderer,
    ShapeFactory,
    UIController
  });
})();
