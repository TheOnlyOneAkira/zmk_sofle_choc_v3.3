/*
 * Keycodes ZMK proposés dans l'éditeur, par catégorie.
 * Les libellés viennent d'abord de keymap_drawer.config.yaml (AZERTY) ;
 * FALLBACK_LABELS ne sert que pour les codes absents de ce fichier.
 */
(function (root) {
  'use strict';

  const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));

  const KEYCODES = [
    { cat: 'Lettres', codes: range(26, (i) => String.fromCharCode(65 + i)) },
    { cat: 'Chiffres', codes: ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N0'] },
    { cat: 'Ponctuation', codes: ['MINUS', 'EQUAL', 'LBKT', 'RBKT', 'BSLH', 'NUBS', 'SEMI', 'SQT', 'GRAVE', 'COMMA', 'DOT', 'FSLH', 'NON_US_HASH'] },
    { cat: 'Édition', codes: ['ESC', 'TAB', 'BSPC', 'RET', 'SPACE', 'DEL', 'INS', 'CAPSLOCK', 'PRINTSCREEN', 'SCROLLLOCK', 'PAUSE_BREAK', 'K_APPLICATION'] },
    { cat: 'Modificateurs', codes: ['LSHIFT', 'RSHFT', 'LCTRL', 'RCTRL', 'LALT', 'RALT', 'LGUI', 'RGUI'] },
    { cat: 'Navigation', codes: ['LEFT', 'RIGHT', 'UP', 'DOWN', 'HOME', 'END', 'PG_UP', 'PG_DN'] },
    { cat: 'Fonctions', codes: range(24, (i) => 'F' + (i + 1)) },
    { cat: 'Pavé numérique', codes: [...range(10, (i) => 'KP_NUMBER_' + i), 'KP_PLUS', 'KP_MINUS', 'KP_MULTIPLY', 'KP_DIVIDE', 'KP_EQUAL', 'KP_DOT', 'KP_ENTER', 'KP_NUM'] },
    { cat: 'Multimédia', codes: ['C_PLAY_PAUSE', 'C_NEXT', 'C_PREVIOUS', 'C_VOL_UP', 'C_VOL_DN', 'C_MUTE', 'C_BRI_UP', 'C_BRI_DN', 'C_AC_SCROLL_UP', 'C_AC_SCROLL_DOWN', 'C_AL_CALC'] },
  ];

  const FALLBACK_LABELS = {
    UP: '↑', PG_UP: 'Page ↑', PG_DN: 'Page ↓', RALT: 'AltGr', RGUI: 'Win',
    RCTRL: 'Ctrl', LSHIFT: '⇧ Maj', SCROLLLOCK: 'Arrêt défil.', PAUSE_BREAK: 'Pause',
    NON_US_HASH: '#', KP_ENTER: 'Entrée ⏎', KP_NUM: 'Verr. num',
    C_BRI_UP: 'Lumin. +', C_BRI_DN: 'Lumin. −', C_AC_SCROLL_UP: 'Défil. ↑',
    C_AC_SCROLL_DOWN: 'Défil. ↓', C_AL_CALC: 'Calc.',
  };

  // Modificateurs de &kp : fonction ZMK -> libellé de la case à cocher
  const MODIFIERS = [
    ['LC', 'Ctrl'], ['LS', 'Maj'], ['LA', 'Alt'], ['RA', 'AltGr'], ['LG', 'Win'],
    ['RC', 'Ctrl droit'], ['RS', 'Maj droit'], ['RG', 'Win droit'],
  ];

  // Touches modificatrices utilisables comme « maintien » de &mt
  const HOLD_MODS = ['LSHIFT', 'LCTRL', 'LALT', 'LGUI', 'RSHFT', 'RCTRL', 'RALT', 'RGUI'];

  const BT_ACTIONS = [
    ['BT_SEL', 'Choisir le profil', true],
    ['BT_DISC', 'Déconnecter le profil', true],
    ['BT_CLR', 'Effacer le profil actif', false],
    ['BT_CLR_ALL', 'Effacer tous les profils', false],
    ['BT_NXT', 'Profil suivant', false],
    ['BT_PRV', 'Profil précédent', false],
  ];

  const RGB_ACTIONS = [
    ['RGB_ON', 'Allumer'], ['RGB_OFF', 'Éteindre'], ['RGB_TOG', 'Allumer / éteindre'],
    ['RGB_EFF', 'Effet suivant'], ['RGB_EFR', 'Effet précédent'],
    ['RGB_BRI', 'Luminosité +'], ['RGB_BRD', 'Luminosité −'],
    ['RGB_HUI', 'Teinte +'], ['RGB_HUD', 'Teinte −'],
    ['RGB_SAI', 'Saturation +'], ['RGB_SAD', 'Saturation −'],
    ['RGB_SPI', 'Vitesse +'], ['RGB_SPD', 'Vitesse −'],
  ];

  const EXT_POWER_ACTIONS = [['EP_TOG', 'Basculer'], ['EP_ON', 'Allumer'], ['EP_OFF', 'Éteindre']];

  // &anim (fork nice-view-gem) : [action, libellé, a besoin d'un numéro]
  const ANIM_ACTIONS = [
    ['ANIM_NXT', 'Animation suivante', false],
    ['ANIM_PRV', 'Animation précédente', false],
    ['ANIM_SEL', "Choisir l'animation n°", true],
    ['ANIM_TOG', 'Animée / image fixe', false],
    ['ANIM_ON', 'Animée', false],
    ['ANIM_OFF', 'Image fixe', false],
  ];

  root.Keycodes = { KEYCODES, FALLBACK_LABELS, MODIFIERS, HOLD_MODS, BT_ACTIONS, RGB_ACTIONS, EXT_POWER_ACTIONS, ANIM_ACTIONS };
})(typeof window !== 'undefined' ? window : globalThis);
