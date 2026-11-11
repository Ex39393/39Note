import type { CSSProperties, ReactNode } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { ReadingTheme } from '../themes';
import {
  DARK_EMPTY_READER_MOTE_COUNT,
  EMPTY_READER_AMBIENT_EFFECT_BY_THEME,
  TWILIGHT_EMPTY_READER_MOTE_COUNT,
  darkEmptyReaderDustGroups,
  twilightEmptyReaderDustGroups,
  type EmptyReaderDustGroup,
  type EmptyReaderDustMote,
} from '../utils/emptyReaderAmbient';

type DustGroupStyle = CSSProperties &
  Record<
    | '--reader-ambient-duration'
    | '--reader-ambient-delay'
    | '--reader-ambient-start-x'
    | '--reader-ambient-start-y'
    | '--reader-ambient-middle-x'
    | '--reader-ambient-middle-y'
    | '--reader-ambient-end-x'
    | '--reader-ambient-end-y',
    string
  >;

type DustMoteStyle = CSSProperties &
  Record<
    | '--reader-ambient-mote-x'
    | '--reader-ambient-mote-y'
    | '--reader-ambient-mote-size'
    | '--reader-ambient-mote-opacity',
    string
  >;

export function EmptyReaderAmbient() {
  const { themeId } = useTheme();

  return (
    <div
      aria-hidden="true"
      className={`reader-empty-ambient reader-empty-ambient--${themeId}`}
      data-empty-reader-effect={EMPTY_READER_AMBIENT_EFFECT_BY_THEME[themeId]}
      data-empty-reader-theme={themeId}
    >
      {renderThemeAmbient(themeId)}
    </div>
  );
}

function renderThemeAmbient(themeId: ReadingTheme): ReactNode {
  switch (themeId) {
    case 'sea':
      return (
        <>
          <span className="reader-empty-sea-surface" />
          <span className="reader-empty-sea-shaft reader-empty-sea-shaft--left" />
          <span className="reader-empty-sea-shaft reader-empty-sea-shaft--right" />
          <span className="reader-empty-sea-current" />
        </>
      );
    case 'bay':
      return null;
    case 'bright':
      return (
        <>
          <span className="reader-empty-bright-bloom reader-empty-bright-bloom--blue" />
          <span className="reader-empty-bright-bloom reader-empty-bright-bloom--pink" />
          <span className="reader-empty-bright-lustre" />
          <span className="reader-empty-bright-veil" />
        </>
      );
    case 'twilight':
      return (
        <>
          <span className="reader-empty-twilight-haze" />
          <span className="reader-empty-twilight-beam reader-empty-twilight-beam--wide" />
          <span className="reader-empty-twilight-beam reader-empty-twilight-beam--narrow" />
          <DustFields
            expectedCount={TWILIGHT_EMPTY_READER_MOTE_COUNT}
            groups={twilightEmptyReaderDustGroups}
            theme="twilight"
          />
        </>
      );
    case 'dark':
      return (
        <>
          <span className="reader-empty-dark-haze" />
          <DustFields
            expectedCount={DARK_EMPTY_READER_MOTE_COUNT}
            groups={darkEmptyReaderDustGroups}
            theme="dark"
          />
        </>
      );
    case 'midnight':
      return (
        <>
          <span className="reader-empty-midnight-depth" />
          <svg
            className="reader-empty-aurora-curtains"
            focusable="false"
            preserveAspectRatio="none"
            viewBox="0 0 1000 620"
          >
            <defs>
              <linearGradient
                id="reader-aurora-left-volume"
                x1="0"
                x2="1"
                y1="0"
                y2="0"
              >
                <stop offset="0" stopColor="#71bbb8" stopOpacity="0.06" />
                <stop offset="0.15" stopColor="#71bbb8" stopOpacity="0.7" />
                <stop offset="0.3" stopColor="#648ebd" stopOpacity="0.3" />
                <stop offset="0.46" stopColor="#6aa6b5" stopOpacity="0.58" />
                <stop offset="0.63" stopColor="#5d80ad" stopOpacity="0.24" />
                <stop offset="0.76" stopColor="#5b86aa" stopOpacity="0.46" />
                <stop offset="0.9" stopColor="#5167a2" stopOpacity="0.04" />
                <stop offset="1" stopColor="#5167a2" stopOpacity="0" />
              </linearGradient>
              <linearGradient
                id="reader-aurora-right-volume"
                x1="1"
                x2="0"
                y1="0"
                y2="0"
              >
                <stop offset="0" stopColor="#657bb6" stopOpacity="0.05" />
                <stop offset="0.16" stopColor="#657bb6" stopOpacity="0.54" />
                <stop offset="0.32" stopColor="#557f9f" stopOpacity="0.23" />
                <stop offset="0.49" stopColor="#667fa7" stopOpacity="0.46" />
                <stop offset="0.67" stopColor="#527e96" stopOpacity="0.19" />
                <stop offset="0.8" stopColor="#5b719e" stopOpacity="0.37" />
                <stop offset="0.92" stopColor="#486c89" stopOpacity="0.03" />
                <stop offset="1" stopColor="#486c89" stopOpacity="0" />
              </linearGradient>
              <linearGradient
                id="reader-aurora-left-fold-volume"
                x1="0"
                x2="1"
                y1="0"
                y2="0"
              >
                <stop offset="0" stopColor="#71bbb8" stopOpacity="0" />
                <stop offset="0.18" stopColor="#71bbb8" stopOpacity="0.08" />
                <stop offset="0.46" stopColor="#79beb8" stopOpacity="0.68" />
                <stop offset="0.68" stopColor="#648ebd" stopOpacity="0.34" />
                <stop offset="0.88" stopColor="#5d80ad" stopOpacity="0.08" />
                <stop offset="1" stopColor="#5d80ad" stopOpacity="0" />
              </linearGradient>
              <linearGradient
                id="reader-aurora-right-fold-volume"
                x1="0"
                x2="1"
                y1="0"
                y2="0"
              >
                <stop offset="0" stopColor="#657bb6" stopOpacity="0" />
                <stop offset="0.24" stopColor="#657bb6" stopOpacity="0.06" />
                <stop offset="0.52" stopColor="#6f84b5" stopOpacity="0.6" />
                <stop offset="0.74" stopColor="#557f9f" stopOpacity="0.3" />
                <stop offset="1" stopColor="#557f9f" stopOpacity="0" />
              </linearGradient>
              <linearGradient
                id="reader-aurora-left-feather"
                gradientUnits="userSpaceOnUse"
                x1="0"
                x2="0"
                y1="-80"
                y2="290"
              >
                <stop offset="0" stopColor="#ffffff" stopOpacity="0.96" />
                <stop offset="0.34" stopColor="#ffffff" stopOpacity="0.84" />
                <stop offset="0.62" stopColor="#ffffff" stopOpacity="0.5" />
                <stop offset="0.84" stopColor="#ffffff" stopOpacity="0.1" />
                <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
              </linearGradient>
              <linearGradient
                id="reader-aurora-right-feather"
                gradientUnits="userSpaceOnUse"
                x1="0"
                x2="0"
                y1="-80"
                y2="285"
              >
                <stop offset="0" stopColor="#ffffff" stopOpacity="0.9" />
                <stop offset="0.36" stopColor="#ffffff" stopOpacity="0.78" />
                <stop offset="0.64" stopColor="#ffffff" stopOpacity="0.42" />
                <stop offset="0.85" stopColor="#ffffff" stopOpacity="0.08" />
                <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
              </linearGradient>
              <mask id="reader-aurora-left-mask" maskUnits="userSpaceOnUse">
                <rect
                  width="1000"
                  height="620"
                  fill="url(#reader-aurora-left-feather)"
                />
              </mask>
              <mask id="reader-aurora-right-mask" maskUnits="userSpaceOnUse">
                <rect
                  width="1000"
                  height="620"
                  fill="url(#reader-aurora-right-feather)"
                />
              </mask>
            </defs>
            <g className="reader-empty-aurora-curtain reader-empty-aurora-curtain--left">
              <path
                className="reader-empty-aurora-volume"
                d="M-140-90 L410-90 C401-25 389 25 378 75 C366 130 356 177 324 215 C291 254 252 264 216 232 C181 201 151 176 112 188 C68 202 25 231-38 246 C-80 256-113 247-140 229 Z"
                fill="url(#reader-aurora-left-volume)"
                mask="url(#reader-aurora-left-mask)"
              />
              <g className="reader-empty-aurora-folds reader-empty-aurora-folds--left">
                <path
                  className="reader-empty-aurora-fold reader-empty-aurora-fold--left-one"
                  d="M -8 -60 C 42 -35 100 -16 129 25 C 156 63 158 110 138 154 C 118 198 79 231 30 245 C 53 197 59 153 48 112 C 36 70 10 32 -8 2 Z"
                  fill="url(#reader-aurora-left-fold-volume)"
                  mask="url(#reader-aurora-left-mask)"
                />
                <path
                  className="reader-empty-aurora-fold reader-empty-aurora-fold--left-two"
                  d="M 125 -66 C 173 -49 242 -18 269 25 C 295 65 286 117 257 163 C 230 206 192 229 150 230 C 174 191 183 149 169 106 C 157 67 135 29 125 -12 Z"
                  fill="url(#reader-aurora-left-fold-volume)"
                  mask="url(#reader-aurora-left-mask)"
                />
                <path
                  className="reader-empty-aurora-fold reader-empty-aurora-fold--left-three"
                  d="M 258 -65 C 303 -39 346 -12 361 22 C 375 56 363 96 341 129 C 319 162 290 179 261 177 C 275 145 281 112 275 81 C 268 47 258 16 258 -12 Z"
                  fill="url(#reader-aurora-left-fold-volume)"
                  mask="url(#reader-aurora-left-mask)"
                />
              </g>
            </g>
            <g className="reader-empty-aurora-curtain reader-empty-aurora-curtain--right">
              <path
                className="reader-empty-aurora-volume"
                d="M675-90 L1140-90 L1140 248 C1087 242 1040 225 997 209 C954 192 917 200 885 228 C851 257 817 267 785 244 C750 220 747 180 742 140 C736 94 714 53 690 18 C676-3 674-41 675-90 Z"
                fill="url(#reader-aurora-right-volume)"
                mask="url(#reader-aurora-right-mask)"
              />
              <g className="reader-empty-aurora-folds reader-empty-aurora-folds--right">
                <path
                  className="reader-empty-aurora-fold reader-empty-aurora-fold--right-one"
                  d="M 782 -64 C 820 -38 875 -18 903 18 C 934 59 935 109 911 153 C 888 195 850 220 806 222 C 829 180 835 141 823 104 C 810 63 790 29 782 -6 Z"
                  fill="url(#reader-aurora-right-fold-volume)"
                  mask="url(#reader-aurora-right-mask)"
                />
                <path
                  className="reader-empty-aurora-fold reader-empty-aurora-fold--right-two"
                  d="M 925 -65 C 974 -48 1037 -22 1075 16 C 1114 56 1123 103 1104 146 C 1087 184 1050 210 998 225 C 1020 182 1022 142 1003 105 C 983 67 947 30 925 -4 Z"
                  fill="url(#reader-aurora-right-fold-volume)"
                  mask="url(#reader-aurora-right-mask)"
                />
              </g>
            </g>
          </svg>
        </>
      );
    case 'dawn':
      return (
        <>
          <span className="reader-empty-dawn-sky" />
          <span className="reader-empty-dawn-light" />
          <svg
            className="reader-empty-dawn-clouds"
            focusable="false"
            preserveAspectRatio="none"
            viewBox="0 0 1000 620"
          >
            <defs>
              <linearGradient id="reader-dawn-wisp-rose" x1="0" x2="1" y1="0" y2="0.35">
                <stop offset="0" stopColor="#ffe1d5" stopOpacity="0" />
                <stop offset="0.24" stopColor="#ffe1d5" stopOpacity="0.3" />
                <stop offset="0.62" stopColor="#edb0bd" stopOpacity="0.2" />
                <stop offset="1" stopColor="#edb0bd" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="reader-dawn-wisp-gold" x1="0" x2="1" y1="1" y2="0">
                <stop offset="0" stopColor="#ffd6b0" stopOpacity="0" />
                <stop offset="0.32" stopColor="#ffd6b0" stopOpacity="0.3" />
                <stop offset="0.72" stopColor="#f6bdaf" stopOpacity="0.18" />
                <stop offset="1" stopColor="#f6bdaf" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              className="reader-empty-dawn-wisp reader-empty-dawn-wisp--one"
              d="M-70 162 C71 119 148 175 246 151 C352 125 439 91 641 123 C536 157 451 181 347 188 C230 197 126 169 -70 222 Z"
              fill="url(#reader-dawn-wisp-rose)"
            />
            <path
              className="reader-empty-dawn-wisp reader-empty-dawn-wisp--two"
              d="M518 283 C641 227 716 252 805 220 C898 187 977 200 1084 249 L1084 298 C958 258 891 269 806 299 C704 336 623 316 518 352 Z"
              fill="url(#reader-dawn-wisp-gold)"
            />
            <path
              className="reader-empty-dawn-wisp reader-empty-dawn-wisp--three"
              d="M-68 462 C63 416 146 449 245 469 C354 491 425 475 537 438 C453 493 359 516 247 510 C137 504 55 480 -68 520 Z"
              fill="url(#reader-dawn-wisp-rose)"
            />
          </svg>
        </>
      );
    case 'mint':
      return (
        <>
          <span className="reader-empty-mint-wash" />
          <span className="reader-empty-mint-caustic reader-empty-mint-caustic--one" />
          <span className="reader-empty-mint-caustic reader-empty-mint-caustic--two" />
          <span className="reader-empty-mint-caustic reader-empty-mint-caustic--three" />
          <span className="reader-empty-mint-caustic reader-empty-mint-caustic--four" />
        </>
      );
    case 'soft-gray':
      return (
        <>
          <span className="reader-empty-frosted-glow" />
          <span className="reader-empty-frosted-sheen reader-empty-frosted-sheen--primary" />
          <span className="reader-empty-frosted-sheen reader-empty-frosted-sheen--secondary" />
          <svg
            className="reader-empty-frosted-reflections"
            focusable="false"
            preserveAspectRatio="none"
            viewBox="0 0 1000 620"
          >
            <defs>
              <linearGradient id="reader-frosted-pearl" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0" stopColor="#f8fbfc" stopOpacity="0" />
                <stop offset="0.27" stopColor="#f8fbfc" stopOpacity="0.45" />
                <stop offset="0.58" stopColor="#b9c7d0" stopOpacity="0.34" />
                <stop offset="0.86" stopColor="#eef3f5" stopOpacity="0.22" />
                <stop offset="1" stopColor="#eef3f5" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="reader-frosted-silver" x1="0" x2="1" y1="1" y2="0">
                <stop offset="0" stopColor="#aebcc6" stopOpacity="0" />
                <stop offset="0.3" stopColor="#aebcc6" stopOpacity="0.26" />
                <stop offset="0.64" stopColor="#ffffff" stopOpacity="0.38" />
                <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              className="reader-empty-frosted-curve reader-empty-frosted-curve--primary"
              d="M-90 505 C118 362 267 405 432 318 C602 227 690 126 1080 112"
              fill="none"
              stroke="url(#reader-frosted-pearl)"
              strokeLinecap="round"
              strokeWidth="82"
            />
            <path
              className="reader-empty-frosted-curve reader-empty-frosted-curve--secondary"
              d="M180-38 C289 87 362 117 491 171 C635 231 770 306 1049 480"
              fill="none"
              stroke="url(#reader-frosted-silver)"
              strokeLinecap="round"
              strokeWidth="58"
            />
          </svg>
        </>
      );
    case 'original':
      return (
        <>
          <span className="reader-empty-paper-light" />
          <span className="reader-empty-window-shadow reader-empty-window-shadow--one" />
          <span className="reader-empty-window-shadow reader-empty-window-shadow--two" />
          <span className="reader-empty-paper-outline reader-empty-paper-outline--one" />
          <span className="reader-empty-paper-outline reader-empty-paper-outline--two" />
          <span className="reader-empty-paper-outline reader-empty-paper-outline--three" />
        </>
      );
  }
}

function DustFields({
  expectedCount,
  groups,
  theme,
}: {
  expectedCount: number;
  groups: readonly EmptyReaderDustGroup[];
  theme: 'dark' | 'twilight';
}) {
  return (
    <div
      className={`reader-empty-dust reader-empty-dust--${theme}`}
      data-mote-count={expectedCount}
    >
      {groups.map((group) => (
        <span
          className={`reader-empty-dust-field reader-empty-dust-field--${group.depth}`}
          data-compact-hidden={group.compactHidden ? 'true' : undefined}
          data-field-mote-count={group.motes.length}
          key={group.id}
          style={getDustGroupStyle(group)}
        >
          {group.motes.map((mote) => (
            <span
              className="reader-empty-dust-mote"
              key={mote.id}
              style={getDustMoteStyle(mote)}
            />
          ))}
        </span>
      ))}
    </div>
  );
}

function getDustGroupStyle(group: EmptyReaderDustGroup): DustGroupStyle {
  return {
    '--reader-ambient-duration': `${group.duration}s`,
    '--reader-ambient-delay': `${group.delay}s`,
    '--reader-ambient-start-x': `${group.motion.start[0]}%`,
    '--reader-ambient-start-y': `${group.motion.start[1]}%`,
    '--reader-ambient-middle-x': `${group.motion.middle[0]}%`,
    '--reader-ambient-middle-y': `${group.motion.middle[1]}%`,
    '--reader-ambient-end-x': `${group.motion.end[0]}%`,
    '--reader-ambient-end-y': `${group.motion.end[1]}%`,
  };
}

function getDustMoteStyle(mote: EmptyReaderDustMote): DustMoteStyle {
  return {
    '--reader-ambient-mote-x': `${mote.x}%`,
    '--reader-ambient-mote-y': `${mote.y}%`,
    '--reader-ambient-mote-size': `${mote.size}px`,
    '--reader-ambient-mote-opacity': String(mote.opacity),
  };
}
