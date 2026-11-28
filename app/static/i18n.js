// UI translations. To add a language: copy one block, translate the values,
// and it appears automatically in the language selector.
export const LANGS = {
  el: {
    _name: "Ελληνικά",
    title: "Χιονόμπαλα",
    hint: "Ανακίνησε το κινητό ή σύρε με το δάχτυλο/ποντίκι",
    enableMotion: "Ενεργοποίηση ανακίνησης",
    choosePhoto: "Επιλογή φωτογραφίας",
    shape: "Σχήμα",
    shapePlaque: "Πλακέτα",
    shapeSphere: "Σφαίρα",
    base: "Βάση",
    baseWood: "Καρυδιά",
    baseGold: "Χρυσό",
    baseIce: "Μάρμαρο",
    snowAmount: "Ποσότητα χιονιού",
    snowSize: "Μέγεθος χιονιού",
    snowColor: "Χρώμα χιονιού",
    share: "Δημιουργία συνδέσμου",
    copy: "Αντιγραφή",
    copied: "Αντιγράφηκε",
    uploading: "Αποστολή…",
    done: "Έτοιμο! Μοιράσου τον σύνδεσμο.",
    errType: "Επιτρέπονται μόνο JPEG, PNG ή WebP.",
    errTooLarge: "Η φωτογραφία είναι πολύ μεγάλη.",
    errRate: "Πάρα πολλές αποστολές, δοκίμασε αργότερα.",
    errGeneric: "Κάτι πήγε στραβά.",
    errNotFound: "Η χιονόμπαλα δεν βρέθηκε.",
    errWebgl: "Το WebGL δεν υποστηρίζεται σε αυτή τη συσκευή.",
  },
  en: {
    _name: "English",
    title: "Snowglobe",
    hint: "Shake your phone, or drag with finger/mouse",
    enableMotion: "Enable shake",
    choosePhoto: "Choose a photo",
    shape: "Shape",
    shapePlaque: "Plaque",
    shapeSphere: "Sphere",
    base: "Base",
    baseWood: "Walnut",
    baseGold: "Gold",
    baseIce: "Marble",
    snowAmount: "Snow amount",
    snowSize: "Snow size",
    snowColor: "Snow color",
    share: "Create share link",
    copy: "Copy",
    copied: "Copied",
    uploading: "Uploading…",
    done: "Done! Share the link.",
    errType: "Only JPEG, PNG or WebP are allowed.",
    errTooLarge: "The photo is too large.",
    errRate: "Too many uploads, try again later.",
    errGeneric: "Something went wrong.",
    errNotFound: "Snowglobe not found.",
    errWebgl: "WebGL is not supported on this device.",
  },
};

let current = "en";

export function pickLang(defaultLang) {
  const saved = localStorage.getItem("sg-lang");
  if (saved && LANGS[saved]) return saved;
  return LANGS[defaultLang] ? defaultLang : "en";
}

export function t(key) {
  return (LANGS[current] && LANGS[current][key]) || LANGS.en[key] || key;
}

export function setLang(code) {
  if (!LANGS[code]) code = "en";
  current = code;
  localStorage.setItem("sg-lang", code);
  document.documentElement.lang = code;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.title = t("title");
}
