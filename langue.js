// Langue des pages principales (accueil, commande, méthode). Chaque langue a sa propre adresse :
// français à la racine, anglais sous /en/ (pages générées par outils/version-anglaise.js), pour que Google
// et les IA, qui ne cliquent pas sur le bouton FR/EN, lisent aussi la version anglaise.
// Chargé dans <head> : la redirection éventuelle part avant l'affichage.
(function () {
  "use strict";
  const page = document.documentElement.lang === "en" ? "en" : "fr";
  // En local (labo/web), il n'y a pas de /en/ : le bouton traduit sur place. Le port 8766 sert labo/site-public.
  const enLigne = !/^(localhost|127\.0\.0\.1)$/.test(location.hostname) || location.port === "8766";
  const robot = /bot|crawl|spider|slurp|preview|lighthouse|google|bing|facebookexternalhit/i.test(navigator.userAgent);
  let choix = null;
  try { choix = localStorage.getItem("labo-langue"); } catch (e) { /* navigation privée */ }

  function adresse(l) {
    let p = location.pathname.replace(/^\/en\//, "/");
    if (p === "/index.html") p = "/";
    return (l === "en" ? "/en" : "") + p + location.search + location.hash;
  }

  // Le bouton FR/EN : retient le choix, puis va à l'adresse de cette langue. Renvoie true si la page change.
  function choisir(l) {
    try { localStorage.setItem("labo-langue", l); } catch (e) { /* rien */ }
    if (!enLigne || l === page) return false;
    location.href = adresse(l);
    return true;
  }

  // Première visite sur une page française avec un navigateur dans une autre langue : direction l'anglais.
  // Jamais pour les robots d'indexation (chaque adresse doit leur montrer sa propre langue), jamais depuis /en/.
  if (enLigne && page === "fr" && !robot) {
    if (choix === "en" || (!choix && (navigator.language || "").slice(0, 2) !== "fr")) location.replace(adresse("en"));
  }

  // En local, on garde l'ancien comportement : la langue choisie s'applique sur place.
  const langue = enLigne ? page : (choix === "en" || choix === "fr" ? choix : page);
  window.LaboLangue = { page, langue, choisir };
})();
