/** Listen Mode (Stillweb Plus): playback speed and a sleep timer for audio and video on any site. */

export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export type SleepChoice = { id: string; label: string; minutes: number | null; endOfMedia?: boolean };

export const SLEEP_CHOICES: SleepChoice[] = [
  { id: '15', label: '15 min', minutes: 15 },
  { id: '30', label: '30 min', minutes: 30 },
  { id: '45', label: '45 min', minutes: 45 },
  { id: '60', label: '1 hour', minutes: 60 },
  { id: 'end', label: 'End of this one', minutes: null, endOfMedia: true },
];

export function speedLabel(rate: number): string {
  return `${rate}×`;
}

/**
 * Sets the speed of the page's audio and video, now and for media it starts later (sites
 * reset the speed when the next video loads).
 */
export function rateScript(rate: number): string {
  return `(function (rate) {
    window.__stillwebRate = rate;
    var apply = function (m) { try { if (m && m.playbackRate !== rate) m.playbackRate = rate; } catch (e) {} };
    if (!window.__stillwebRateHooked) {
      window.__stillwebRateHooked = true;
      ['play', 'playing', 'loadedmetadata'].forEach(function (type) {
        document.addEventListener(type, function (e) {
          var r = window.__stillwebRate;
          if (r && r !== 1 && e.target && 'playbackRate' in e.target && e.target.playbackRate !== r) {
            try { e.target.playbackRate = r; } catch (err) {}
          }
        }, true);
      });
    }
    document.querySelectorAll('video, audio').forEach(apply);
    return true;
  })(${Number(rate)})`;
}

/**
 * Sleep timer "end of this one": when the current audio or video ends, whatever starts next
 * (a playlist's autoplay) is paused, as the user's own pause.
 */
export function stopAtEndScript(on: boolean): string {
  return `(function (on) {
    window.__stillwebStopAtEnd = on ? 'waiting' : false;
    if (!window.__stillwebStopAtEndHooked) {
      window.__stillwebStopAtEndHooked = true;
      document.addEventListener('ended', function () {
        if (window.__stillwebStopAtEnd === 'waiting') window.__stillwebStopAtEnd = 'ended';
      }, true);
      document.addEventListener('play', function (e) {
        if (window.__stillwebStopAtEnd !== 'ended') return;
        window.__stillwebStopAtEnd = false;
        var m = e.target;
        setTimeout(function () {
          try { if (window.__stillwebUserPause) window.__stillwebUserPause(); } catch (err) {}
          try { m.pause(); } catch (err) {}
        }, 0);
      }, true);
    }
    return true;
  })(${on ? 'true' : 'false'})`;
}
