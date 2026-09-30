import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

// jsdom has no Web Animations; RAC's SelectionIndicator asks every element for its animations.
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

// jsdom has no matchMedia; motion and the theme code ask it for reduced motion.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }) as MediaQueryList;
}
