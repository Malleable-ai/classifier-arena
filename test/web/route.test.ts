import { describe, expect, it } from 'vitest';
import { gamePath, parseRoute } from '../../src/web/route.js';

const GAMES = ['fighter', 'inbox', 'clues'];
const route = (path: string, search = '') => parseRoute(path, search, GAMES);

describe('parseRoute', () => {
  it('opens home at /, whatever the query', () => {
    expect(route('/')).toEqual({ mode: 'home' });
    expect(route('')).toEqual({ mode: 'home' });
    expect(route('/', '?match=x')).toEqual({ mode: 'home' });
  });

  it("opens a game's history at /<game>, with no match picked", () => {
    expect(route('/fighter')).toEqual({ mode: 'history', game: 'fighter', matchId: null });
    expect(route('/fighter/')).toEqual({ mode: 'history', game: 'fighter', matchId: null });
    expect(route('/clues', '?match=')).toEqual({ mode: 'history', game: 'clues', matchId: null });
  });

  it('opens the history on ?match=<id>', () => {
    expect(route('/fighter', '?match=abc-1')).toEqual({
      mode: 'history',
      game: 'fighter',
      matchId: 'abc-1',
    });
    expect(route('/inbox', '?match=%20x-2%20')).toEqual({
      mode: 'history',
      game: 'inbox',
      matchId: 'x-2',
    });
  });

  it('opens render mode on ?match=<id>&render=1, and needs a match id for it', () => {
    expect(route('/fighter', '?match=abc-1&render=1')).toEqual({
      mode: 'render',
      game: 'fighter',
      matchId: 'abc-1',
    });
    expect(route('/fighter', '?render=1')).toEqual({
      mode: 'history',
      game: 'fighter',
      matchId: null,
    });
    expect(route('/fighter', '?match=&render=1')).toMatchObject({ mode: 'history', matchId: null });
  });

  it('keeps a video size and an external log url on render mode', () => {
    expect(route('/inbox', '?match=abc-1&render=1&size=1080x1080')).toEqual({
      mode: 'render',
      game: 'inbox',
      matchId: 'abc-1',
      size: { width: 1080, height: 1080 },
    });
    expect(
      route('/clues', '?match=abc-1&render=1&size=1920x1080&log=%2F__render%2Fabc-1.jsonl'),
    ).toEqual({
      mode: 'render',
      game: 'clues',
      matchId: 'abc-1',
      size: { width: 1920, height: 1080 },
      log: '/__render/abc-1.jsonl',
    });
    // A bad size falls back to the viewer's layout; size means nothing without render=1.
    expect(route('/fighter', '?match=abc-1&render=1&size=huge')).toEqual({
      mode: 'render',
      game: 'fighter',
      matchId: 'abc-1',
    });
    expect(route('/fighter', '?match=abc-1&size=1080x1080')).toMatchObject({ mode: 'history' });
  });

  it('opens a video card at /?card=<name>&render=1, 1920x1080 unless sized', () => {
    expect(route('/', '?card=intro&render=1')).toEqual({
      mode: 'card',
      card: 'intro',
      size: { width: 1920, height: 1080 },
      fixture: false,
    });
    expect(route('/', '?card=outro&render=1&size=1080x1080&fixture=1')).toEqual({
      mode: 'card',
      card: 'outro',
      size: { width: 1080, height: 1080 },
      fixture: true,
    });
    expect(route('/', '?card=intro')).toEqual({ mode: 'home' });
    expect(route('/', '?card=&render=1')).toEqual({ mode: 'home' });
  });

  it('opens live mode at /live (main.ts drops it from the web build)', () => {
    expect(route('/live')).toEqual({ mode: 'live' });
    expect(route('/live/')).toEqual({ mode: 'live' });
  });

  it('opens the sandbox only for the fighter, keeping p1 and seed', () => {
    expect(route('/fighter', '?sandbox=1&p1=random&seed=9')).toEqual({
      mode: 'sandbox',
      game: 'fighter',
      p1: 'random',
      seed: 9,
    });
    expect(route('/fighter', '?sandbox=1&seed=4294967296')).toMatchObject({ seed: 1 });
    expect(route('/inbox', '?sandbox=1')).toEqual({
      mode: 'history',
      game: 'inbox',
      matchId: null,
    });
  });

  it('is not-found for an unknown game or a deeper path', () => {
    expect(route('/chess')).toEqual({ mode: 'not-found' });
    expect(route('/chess', '?match=abc-1&render=1')).toEqual({ mode: 'not-found' });
    expect(route('/fighter/matches')).toEqual({ mode: 'not-found' });
    expect(route('/Fighter')).toEqual({ mode: 'not-found' });
    expect(parseRoute('/fighter', '', [])).toEqual({ mode: 'not-found' });
  });
});

describe('gamePath', () => {
  it('links a game page and one replay on it', () => {
    expect(gamePath('fighter')).toBe('/fighter');
    expect(gamePath('fighter', null)).toBe('/fighter');
    expect(gamePath('fighter', '20261007-225537-fighter-random-vs-scripted-1')).toBe(
      '/fighter?match=20261007-225537-fighter-random-vs-scripted-1',
    );
  });

  it('round-trips through parseRoute', () => {
    const id = '20261007-225537-fighter-random-vs-scripted-1';
    const url = new URL(gamePath('fighter', id), 'http://x');
    expect(parseRoute(url.pathname, url.search, GAMES)).toEqual({
      mode: 'history',
      game: 'fighter',
      matchId: id,
    });
  });
});
