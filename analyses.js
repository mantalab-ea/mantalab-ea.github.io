/**
 * MantaLab — analyses statistiques d'un backtest (après la détection de comportements d'engine.js).
 *
 *   1. Solidité : l'avantage du robot est-il réel ou un coup de chance / de sur-optimisation ?
 *      Sharpe probabiliste et « dégonflé » (Bailey & López de Prado), durée minimale d'historique,
 *      stabilité dans le temps, dépendance à quelques gros gains, rééchantillonnage par blocs.
 *   2. Intégrité : pertes latentes cachées (drawdown d'équité ≫ drawdown du solde), trous d'activité,
 *      courbe anormalement régulière.
 *   3. Challenges de prop firms : règles officielles (vérifiées le 22/11/2026), simulation Monte-Carlo
 *      + rejeu réel depuis chaque jour de départ, à plusieurs tailles de position.
 *   4. Deux notes sur 100 (sécurité, solidité) avec le détail de chaque point retiré ou gagné.
 *
 * Tout est DÉTERMINISTE : le hasard est tiré d'une graine calculée sur les trades, donc un même
 * rapport donne toujours exactement les mêmes chiffres.
 * Utilisable dans le navigateur (window.LaboAnalyses) et dans Node (require).
 */
(function (root) {
  "use strict";

  const JOUR = 86400000;
  const PARAMS = {
    minJours: 20, minPositions: 30,        // en dessous : pas de conclusion statistique
    essaisSupposes: 100,                   // Sharpe dégonflé : on suppose 100 réglages essayés par le vendeur
    blocJours: 20,                         // rééchantillonnage par blocs d'un mois : garde les séries de pertes
                                           // (5 jours les coupait : GridPro 47 % simulé contre 29 % réel)
    tirages: 1000,
    tranches: 4,                           // stabilité : l'historique coupé en 4 périodes égales
    multiplicateurs: [0.25, 0.5, 1, 2],    // tailles de position testées pour les challenges
    minDepartsReels: 20,                   // rejeu réel : en dessous, pourcentage non significatif
    trouMinJours: 30, trouFoisMediane: 10, // trou d'activité suspect
    latentesAttention: 1.5, latentesAlerte: 2.5, latentesMinDD: 0.1,
    lisseR2: 0.98, lisseTaux: 0.8, lisseMinPositions: 100,
  };

  // Règles OFFICIELLES lues sur les sites des firmes le 22/11/2026. « jour » et « max » en fraction du
  // capital initial. Limites calculées sur le solde de début de journée (FTMO : 00:00 CE(S)T).
  const FIRMES = [
    { id: "ftmo_2", nom: "FTMO 2-Step", phases: [0.10, 0.05], jour: 0.05, max: 0.10, suiveur: false, minJours: 4,
      source: "ftmo.com/en/trading-objectives" },
    { id: "ftmo_1", nom: "FTMO 1-Step", phases: [0.10], jour: 0.03, max: 0.10, suiveur: true, minJours: 0, meilleurJourMax: 0.5,
      source: "ftmo.com/en/trading-objectives" },
    { id: "fn_2", nom: "FundedNext Stellar 2-Step", phases: [0.08, 0.05], jour: 0.05, max: 0.10, suiveur: false, minJours: 5, quickStrike: 0.3,
      source: "help.fundednext.com" },
    { id: "fn_1", nom: "FundedNext Stellar 1-Step", phases: [0.10], jour: 0.03, max: 0.06, suiveur: false, minJours: 2, quickStrike: 0.3,
      source: "help.fundednext.com" },
    { id: "fn_lite", nom: "FundedNext Stellar Lite", phases: [0.08, 0.04], jour: 0.04, max: 0.08, suiveur: false, minJours: 2, quickStrike: 0.3,
      source: "help.fundednext.com" },
    // The5ers (FAQ officielle du 16/11/2026) : perte journalière = 5 % du solde/équité de DÉBUT DE JOURNÉE (le plus
    // haut des deux), pas du capital initial ; perte maximale fixe depuis le capital initial. 3-5 % / 8-10 % selon le
    // compte : on prend les valeurs du tableau officiel (5 % / 10 %).
    { id: "the5ers_hs", nom: "The5ers High Stakes", phases: [0.10, 0.05], jour: 0.05, jourSurSoldeDuJour: true, max: 0.10, suiveur: false, minJours: 0,
      minJoursGagnants: 3, seuilJourGagnant: 0.005, selonCompte: true, source: "the5ers.com/faqs (16/11/2026)" },
  ];

  // ---------------------------------------------------------------- outils numériques

  /** Générateur pseudo-aléatoire mulberry32 (rapide, reproductible). */
  function alea(graine) {
    let a = graine >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Graine FNV-1a calculée sur les trades : même rapport → mêmes tirages. */
  function graineDe(positions) {
    let h = 2166136261;
    for (const p of positions) {
      const s = p.ouverture + "|" + (p.fermeture || 0) + "|" + p.profit.toFixed(2);
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    }
    return h >>> 0;
  }

  /** Fonction de répartition de la loi normale (erfc de Numerical Recipes, erreur < 1,2e-7). */
  function Phi(x) {
    const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
      t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? 1 - r / 2 : r / 2;
  }

  /** Inverse de la loi normale (algorithme d'Acklam, erreur relative < 1,15e-9). */
  function PhiInv(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const bas = 0.02425;
    if (p < bas) {
      const q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > 1 - bas) return -PhiInv(1 - p);
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  /** Moyenne, écart-type (n-1), asymétrie et aplatissement (non centré : loi normale = 3). */
  function moments(x) {
    const n = x.length;
    const m = x.reduce((s, v) => s + v, 0) / n;
    let m2 = 0, m3 = 0, m4 = 0;
    for (const v of x) { const e = v - m; m2 += e * e; m3 += e * e * e; m4 += e * e * e * e; }
    m2 /= n; m3 /= n; m4 /= n;
    return { n, moyenne: m, ecartType: n > 1 ? Math.sqrt(m2 * n / (n - 1)) : 0,
      asymetrie: m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0, aplatissement: m2 > 0 ? m4 / (m2 * m2) : 3 };
  }

  const quantile = (trie, q) => trie.length ? trie[Math.min(trie.length - 1, Math.max(0, Math.round(q * (trie.length - 1))))] : null;
  const borner = (x, a, b) => Math.max(a, Math.min(b, x));
  const arr = (x, d = 4) => (x === null || x === undefined || !isFinite(x) ? x : +x.toFixed(d));

  // ---------------------------------------------------------------- série journalière

  /**
   * Un enregistrement par jour de cotation (lundi-vendredi, + week-ends où le robot a agi) :
   * résultat des positions FERMÉES ce jour-là, en fraction du solde du début de journée.
   */
  function serieJours(positions, debut, fin, depot, mouvements, creuxParJour) {
    const pnl = new Map(), ouv = new Map(), mvt = new Map();
    // dépôts / retraits en cours de route (signaux) : ils changent le solde, ce ne sont ni des gains ni des pertes
    for (const m of mouvements || []) { const k = Math.floor(m.temps / JOUR); mvt.set(k, (mvt.get(k) || 0) + m.montant); }
    for (const p of positions) {
      const ko = Math.floor(p.ouverture / JOUR);
      ouv.set(ko, (ouv.get(ko) || 0) + 1);
      if (p.fermeture !== null) {
        const k = Math.floor(p.fermeture / JOUR);
        pnl.set(k, (pnl.get(k) || 0) + p.profit);
      }
    }
    const d0 = Math.floor(debut / JOUR), d1 = Math.floor(fin / JOUR);
    const jours = [];
    let solde = depot;
    for (let k = d0; k <= d1; k++) {
      const g = pnl.get(k) || 0, o = ouv.get(k) || 0;
      const js = new Date(k * JOUR).getUTCDay();
      if ((js === 0 || js === 6) && !g && !o) continue;
      const r = solde > 0 ? Math.max(-1, g / solde) : 0;
      // creux : pire moment de la journée (équité) en fraction du solde de minuit ; à défaut, le résultat fermé
      const creux = Math.min(0, r, creuxParJour && creuxParJour.has(k) ? creuxParJour.get(k) : 0);
      jours.push({ k, pnl: g, r, ouvertes: o, creux });
      solde += g + (mvt.get(k) || 0);
    }
    return jours;
  }

  // ---------------------------------------------------------------- équité minute par minute (audits du labo)

  /** CSV de LaboBarres : « time;open;high;low;close;spread », time = « 2026.11.18 23:57 » (heure du serveur). */
  function lireBarres(texte) {
    const L = String(texte).split(/\r?\n/), n = L.length;
    const t = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n), e = new Float64Array(n);
    let m = 0, decimales = 0;
    for (let i = 1; i < n; i++) {
      const x = L[i].split(";");
      if (x.length < 5) continue;
      const d = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})/.exec(x[0]);
      if (!d) continue;
      t[m] = Date.UTC(+d[1], +d[2] - 1, +d[3], +d[4], +d[5]); h[m] = +x[2]; l[m] = +x[3]; c[m] = +x[4]; e[m] = +x[5] || 0; m++;
      const dec = (x[4].split(".")[1] || "").length;
      if (dec > decimales) decimales = dec;
    }
    // écart (spread) en points → en prix : un point = 10^-décimales du cours écrit par LaboBarres (_Digits)
    const point = Math.pow(10, -decimales);
    for (let i = 0; i < m; i++) e[i] *= point;
    return { t: t.subarray(0, m), h: h.subarray(0, m), l: l.subarray(0, m), c: c.subarray(0, m), ecart: e.subarray(0, m) };
  }

  /**
   * Équité minute par minute : solde (positions fermées, dépôts) + pertes LATENTES des positions encore ouvertes,
   * évaluées au pire de chaque minute : TOUTES au plus bas, ou TOUTES au plus haut (le cours ne peut pas être aux deux
   * à la fois : un robot qui couvre achats et ventes n'est pas pénalisé deux fois ; Zone Recovery, 22/11/2026).
   * Les ventes se rachètent au prix demandé : cours + écart (spread). La valeur d'un point par
   * lot est retrouvée dans les trades eux-mêmes (profit ÷ écart de prix ÷ volume), symbole par symbole.
   * Rend, par jour, le creux d'équité en fraction du solde de minuit — ce que surveillent les prop firms.
   */
  function equiteMinute(positions, barres, depot, mouvements, points) {
    const B = barres, n = B.t.length, MIN = 60000;
    // points (facultatif) : nombre de points de la courbe à renvoyer (fiche PDF) ; n'influe sur aucun autre résultat
    const pas = points ? Math.max(1, Math.ceil(n / points)) : 0, serie = pas ? { t: [], solde: [], bas: [] } : null;
    let creuxSeg = Infinity;
    const valeurs = new Map();
    for (const p of positions) {
      if (p.fermeture === null || p.prixSortie === null || !(p.volume > 0)) continue;
      const ecart = (p.sens === "buy" ? 1 : -1) * (p.prixSortie - p.prixEntree);
      if (Math.abs(ecart) < 1e-9 || Math.abs(p.profit) < 1e-6) continue;
      const v = p.profit / (ecart * p.volume);
      if (v > 0) { if (!valeurs.has(p.symbole)) valeurs.set(p.symbole, []); valeurs.get(p.symbole).push(v); }
    }
    const valeurPoint = new Map();
    for (const [sym, v] of valeurs) { v.sort((a, b) => a - b); valeurPoint.set(sym, v[Math.floor(v.length / 2)]); }
    // un seul jeu de barres : celui du symbole principal (robots du labo = un symbole)
    const tri = positions.slice().sort((a, b) => a.ouverture - b.ouverture);
    const fermetures = positions.filter((p) => p.fermeture !== null).sort((a, b) => a.fermeture - b.fermeture);
    const mvts = (mouvements || []).slice().sort((a, b) => a.temps - b.temps);
    let io = 0, ifm = 0, im = 0, solde = depot, pic = depot, ddMax = 0, quand = null;
    const ouvertes = [], parJour = new Map();
    let jourCourant = null, soldeMinuit = depot, creux = 0;
    for (let i = 0; i < n; i++) {
      const debutBarre = B.t[i], finBarre = debutBarre + MIN;
      const jour = Math.floor(debutBarre / JOUR);
      if (jour !== jourCourant) {
        if (jourCourant !== null) parJour.set(jourCourant, creux);
        jourCourant = jour; soldeMinuit = solde; creux = 0;
      }
      while (io < tri.length && tri[io].ouverture < finBarre) ouvertes.push(tri[io++]);
      while (ifm < fermetures.length && fermetures[ifm].fermeture <= finBarre) solde += fermetures[ifm++].profit;
      while (im < mvts.length && mvts[im].temps <= finBarre) { solde += mvts[im].montant; pic += mvts[im].montant; im++; }
      let auPlusBas = 0, auPlusHaut = 0, flotFin = 0;
      const ec = B.ecart ? B.ecart[i] : 0;
      for (let k = ouvertes.length - 1; k >= 0; k--) {
        const p = ouvertes[k];
        if (p.fermeture !== null && p.fermeture <= finBarre) { ouvertes.splice(k, 1); continue; }
        const vp = valeurPoint.get(p.symbole);
        if (!vp) continue;
        const q = p.volume * vp;
        if (p.sens === "buy") { auPlusBas += (B.l[i] - p.prixEntree) * q; auPlusHaut += (B.h[i] - p.prixEntree) * q; flotFin += (B.c[i] - p.prixEntree) * q; }
        else { auPlusBas += (p.prixEntree - B.l[i] - ec) * q; auPlusHaut += (p.prixEntree - B.h[i] - ec) * q; flotFin += (p.prixEntree - B.c[i] - ec) * q; }
      }
      const bas = solde + Math.min(auPlusBas, auPlusHaut);
      if (soldeMinuit > 0) creux = Math.min(creux, (bas - soldeMinuit) / soldeMinuit);
      if (pic > 0 && 1 - bas / pic > ddMax) { ddMax = 1 - bas / pic; quand = debutBarre; }
      pic = Math.max(pic, solde + flotFin);
      if (serie) {
        creuxSeg = Math.min(creuxSeg, bas);
        if ((i + 1) % pas === 0 || i === n - 1) { serie.t.push(debutBarre); serie.solde.push(arr(solde, 2)); serie.bas.push(arr(creuxSeg, 2)); creuxSeg = Infinity; }
      }
    }
    if (jourCourant !== null) parJour.set(jourCourant, creux);
    const couvertes = positions.filter((p) => valeurPoint.has(p.symbole)).length;
    return { parJour, ddEquite: arr(ddMax), quand, couverture: arr(couvertes / Math.max(1, positions.length), 3), barres: n, serie };
  }

  // ---------------------------------------------------------------- 1. solidité

  /**
   * Bailey & López de Prado. psr = probabilité que le vrai Sharpe soit > 0 vu la longueur et la forme
   * (asymétrie, queues épaisses) de la série ; dsr = idem en exigeant de battre le meilleur de N essais
   * SANS avantage (sur-optimisation) ; minJours = historique nécessaire pour conclure à 95 %.
   */
  function statsSharpe(r, N) {
    const m = moments(r);
    // écart-type nul… ou résidu d'arrondi (série constante) : pas de Sharpe, sinon il serait astronomique
    if (r.length < 3 || !(m.ecartType > 1e-12 * Math.max(1e-12, Math.abs(m.moyenne)))) return null;
    const n = r.length, sr = m.moyenne / m.ecartType;
    const v = 1 - m.asymetrie * sr + ((m.aplatissement - 1) / 4) * sr * sr;
    const den = Math.sqrt(Math.max(v, 1e-12));
    const psr = Phi((sr * Math.sqrt(n - 1)) / den);
    const g = 0.5772156649015329;
    const sr0 = (den / Math.sqrt(n - 1)) * ((1 - g) * PhiInv(1 - 1 / N) + g * PhiInv(1 - 1 / (N * Math.E)));
    const dsr = Phi(((sr - sr0) * Math.sqrt(n - 1)) / den);
    const minJours = sr > 0 ? Math.ceil(1 + Math.max(v, 1e-12) * Math.pow(PhiInv(0.95) / sr, 2)) : null;
    return { n, sr, psr, dsr, sr0, minJours, m };
  }

  function solidite(jours, positions, backtest, P, rng) {
    const fermees = positions.filter((p) => p.fermeture !== null).sort((a, b) => a.fermeture - b.fermeture);
    if (jours.length < P.minJours || fermees.length < P.minPositions)
      return { niveau: "inconnu", cle: "pas_assez", jours: jours.length, positions: fermees.length };
    const r = jours.map((j) => j.r);
    const st = statsSharpe(r, P.essaisSupposes);
    if (!st) return { niveau: "inconnu", cle: "sans_variation", jours: jours.length, positions: fermees.length };
    const { n, sr, psr, dsr, minJours, m } = st;
    const span = (Math.floor(backtest.fin / JOUR) - Math.floor(backtest.debut / JOUR) + 1) / 365.25;
    const joursParAn = n / Math.max(span, 1 / 365.25);

    // Stabilité : l'historique coupé en tranches de durée égale.
    const t0 = backtest.debut, duree = Math.max(1, backtest.fin - backtest.debut);
    const tranches = Array.from({ length: P.tranches }, (_, i) => ({ debut: t0 + (duree * i) / P.tranches, fin: t0 + (duree * (i + 1)) / P.tranches, net: 0, positions: 0 }));
    for (const p of fermees) {
      const i = Math.min(P.tranches - 1, Math.floor(((p.fermeture - t0) / duree) * P.tranches));
      tranches[i].net += p.profit; tranches[i].positions++;
    }
    const net = fermees.reduce((s, p) => s + p.profit, 0);
    const positives = tranches.filter((t) => t.net > 0).length;
    const partMeilleureTranche = net > 0 ? tranches.reduce((a, t) => Math.max(a, t.net), -Infinity) / net : null;

    // Dépendance aux meilleurs trades.
    const gains = fermees.map((p) => p.profit).sort((a, b) => b - a);
    const k5 = Math.max(1, Math.ceil(0.05 * gains.length));
    const sansTop5 = net - gains.slice(0, 5).reduce((s, x) => s + x, 0);
    const sansTop5pct = net - gains.slice(0, k5).reduce((s, x) => s + x, 0);

    // Rééchantillonnage par blocs CIRCULAIRE : 1 000 historiques plausibles de même durée. Circulaire = chaque
    // jour a la même chance d'être tiré, y compris les derniers (sinon un robot qui explose en fin de test
    // paraît bien plus sûr qu'il ne l'est : GridPro, 22/11/2026).
    const b = Math.min(P.blocJours, n);
    const finals = [], dds = [];
    for (let s = 0; s < P.tirages; s++) {
      let eq = 1, pic = 1, ddMax = 0, i = 0;
      while (i < n) {
        const dep = Math.floor(rng() * n);
        for (let j = 0; j < b && i < n; j++, i++) {
          eq = Math.max(0, eq * (1 + r[(dep + j) % n]));
          if (eq > pic) pic = eq;
          const dd = pic > 0 ? 1 - eq / pic : 1;
          if (dd > ddMax) ddMax = dd;
        }
      }
      finals.push(eq - 1); dds.push(ddMax);
    }
    finals.sort((a, c) => a - c); dds.sort((a, c) => a - c);
    const pPerte = finals.filter((x) => x < 0).length / finals.length;

    return {
      niveau: "ok", jours: n, positions: fermees.length,
      sharpeJour: arr(sr, 5), sharpeAnnuel: arr(sr * Math.sqrt(joursParAn), 3),
      asymetrie: arr(m.asymetrie, 3), aplatissement: arr(m.aplatissement, 3),
      psr: arr(psr), dsr: arr(dsr), essaisSupposes: P.essaisSupposes, minJours, historiqueSuffisant: minJours !== null && n >= minJours,
      tranches: tranches.map((t) => ({ debut: Math.round(t.debut), fin: Math.round(t.fin), net: arr(t.net, 2), positions: t.positions })),
      tranchesPositives: positives, partMeilleureTranche: arr(partMeilleureTranche, 3),
      net: arr(net, 2), sansTop5: arr(sansTop5, 2), sansTop5pct: arr(sansTop5pct, 2), top5pctN: k5,
      bootstrap: { tirages: P.tirages, blocJours: b, pPerte: arr(pPerte, 3),
        rendementP5: arr(quantile(finals, 0.05)), rendementMedian: arr(quantile(finals, 0.5)),
        ddMedian: arr(quantile(dds, 0.5)), ddP95: arr(quantile(dds, 0.95)) },
    };
  }

  // ---------------------------------------------------------------- 2. intégrité

  function integrite(positions, backtest, audit, P) {
    const fermees = positions.filter((p) => p.fermeture !== null).sort((a, b) => a.fermeture - b.fermeture);
    const res = { constats: [] };
    // Drawdown du SOLDE (positions fermées) en fraction du plus haut atteint.
    // Un retrait n'est pas une perte : il décale le solde ET son plus haut.
    const mvts = (backtest.mouvements || []).slice().sort((a, b) => a.temps - b.temps);
    let solde = backtest.depot, pic = solde, ddSolde = 0, im = 0;
    for (const p of fermees) {
      while (im < mvts.length && mvts[im].temps <= p.fermeture) { solde += mvts[im].montant; pic += mvts[im].montant; im++; }
      solde += p.profit; if (solde > pic) pic = solde; if (pic > 0) ddSolde = Math.max(ddSolde, 1 - solde / pic);
    }
    res.ddSolde = arr(ddSolde);
    // Pertes latentes cachées : le pire moment se voit sur l'équité (positions ouvertes) et pas sur le solde.
    const ddEq = backtest.stats ? backtest.stats.drawdownEquiteMaxPct : undefined;
    if (ddEq !== undefined && ddEq !== null) {
      res.ddEquite = arr(ddEq);
      const ratio = ddEq / Math.max(ddSolde, 0.001);
      res.ratioLatentes = arr(ratio, 2);
      const niv = ddEq >= P.latentesMinDD && ratio >= P.latentesAlerte ? "alerte" : ddEq >= P.latentesMinDD && ratio >= P.latentesAttention ? "attention" : "ok";
      res.constats.push({ code: "latentes", niveau: niv, mesures: { ddEquite: arr(ddEq), ddSolde: arr(ddSolde), ratio: arr(ratio, 2) } });
    } else {
      res.constats.push({ code: "latentes", niveau: "inconnu", mesures: { ddSolde: arr(ddSolde) } });
    }
    // Trous d'activité : périodes sans AUCUNE position ouverte, anormalement longues pour ce robot.
    const tri = positions.slice().sort((a, b) => a.ouverture - b.ouverture);
    const ecarts = [];
    for (let i = 1; i < tri.length; i++) ecarts.push(tri[i].ouverture - tri[i - 1].ouverture);
    ecarts.sort((a, b) => a - b);
    const med = quantile(ecarts, 0.5) || 0;
    const trous = [];
    let finOccupe = -Infinity;
    for (const p of tri) {
      if (finOccupe > -Infinity && p.ouverture > finOccupe) {
        const d = p.ouverture - finOccupe;
        if (d >= P.trouMinJours * JOUR && d >= P.trouFoisMediane * med) trous.push({ debut: finOccupe, fin: p.ouverture, jours: Math.round(d / JOUR) });
      }
      finOccupe = Math.max(finOccupe, p.fermeture === null ? Infinity : p.fermeture);
    }
    trous.sort((a, b) => b.jours - a.jours);
    res.constats.push({ code: "trous", niveau: tri.length < P.minPositions ? "inconnu" : trous.length ? "attention" : "ok",
      mesures: { trous: trous.length, plusLong: trous.length ? trous[0].jours : 0, ecartMedianHeures: arr(med / 3600000, 1) }, exemples: trous.slice(0, 3) });
    // Courbe du solde anormalement régulière (R² proche de 1) avec un très haut taux de réussite.
    if (fermees.length >= 3) {
      const xs = fermees.map((p) => p.fermeture), ys = [];
      let s = 0;
      for (const p of fermees) { s += p.profit; ys.push(s); }
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < xs.length; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
      const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
      const pente = sxx > 0 ? sxy / sxx : 0;
      const taux = fermees.filter((p) => p.profit > 0).length / fermees.length;
      const lisse = fermees.length >= P.lisseMinPositions && pente > 0 && r2 >= P.lisseR2 && taux >= P.lisseTaux;
      res.constats.push({ code: "lisse", niveau: lisse ? "attention" : "ok", mesures: { r2: arr(r2, 4), taux: arr(taux, 3) } });
    }
    return res;
  }

  // ---------------------------------------------------------------- 3. challenges de prop firms

  /** Joue UNE phase. suivant() rend un jour {r, ouvertes} ou null (fin de l'historique réel). */
  function jouerPhase(f, cible, suivant, k, horizon) {
    let solde = 1, plusHautFinJour = 1, jours = 0, joursTrades = 0, joursGagnants = 0, meilleurJour = 0;
    while (jours < horizon) {
      const d = suivant();
      if (!d) return { issue: "fin", jours };
      jours++;
      const debut = solde;
      const g = k * d.r * debut;
      solde = debut + g;
      if (d.ouvertes > 0) joursTrades++;
      if (f.seuilJourGagnant !== undefined && g >= f.seuilJourGagnant) joursGagnants++;
      if (g > meilleurJour) meilleurJour = g;
      // pire moment de la journée : creux d'équité (minute par minute) quand on l'a, sinon le résultat fermé
      const bas = debut + k * Math.min(d.creux === undefined ? 0 : d.creux, d.r, 0) * debut;
      const limiteJour = f.jourSurSoldeDuJour ? f.jour * debut : f.jour; // en fraction du capital initial
      if (bas <= debut - limiteJour) return { issue: "echec", raison: "jour", jours };
      const plancher = f.suiveur ? Math.max(plusHautFinJour, 1) - f.max : 1 - f.max;
      if (bas <= plancher || solde <= plancher) return { issue: "echec", raison: "max", jours };
      if (solde > plusHautFinJour) plusHautFinJour = solde;
      const gain = solde - 1;
      if (gain >= cible && joursTrades >= f.minJours && joursGagnants >= (f.minJoursGagnants || 0) &&
          (!f.meilleurJourMax || meilleurJour <= f.meilleurJourMax * gain)) return { issue: "reussite", jours };
    }
    return { issue: "non_atteint", jours };
  }

  /** Le challenge entier (phases enchaînées) doit tenir dans `horizon` jours : jamais plus que l'historique. */
  function jouerChallenge(f, suivant, k, horizon) {
    let total = 0;
    for (const cible of f.phases) {
      const r = jouerPhase(f, cible, suivant, k, horizon - total);
      total += r.jours;
      if (r.issue !== "reussite") return Object.assign(r, { jours: total });
    }
    return { issue: "reussite", jours: total };
  }

  function challenges(jours, positions, integ, P, rng) {
    if (jours.length < P.minJours) return { niveau: "inconnu", cle: "pas_assez", jours: jours.length };
    const n = jours.length, b = Math.min(P.blocJours, n);
    const courts30 = positions.filter((p) => p.fermeture !== null && p.fermeture - p.ouverture < 30000).length / Math.max(1, positions.length);
    const latentes = (integ.constats.find((c) => c.code === "latentes") || {}).niveau;
    const firmes = FIRMES.map((f) => {
      const parTaille = P.multiplicateurs.map((k) => {
        let reussites = 0, echecsJour = 0, echecsMax = 0, nonAtteints = 0;
        const joursReussite = [];
        for (let s = 0; s < P.tirages; s++) {
          let dep = 0, j = b;
          const suivant = () => { if (j >= b) { dep = Math.floor(rng() * n); j = 0; } return jours[(dep + j++) % n]; };
          const r = jouerChallenge(f, suivant, k, n);
          if (r.issue === "reussite") { reussites++; joursReussite.push(r.jours); }
          else if (r.issue === "echec") r.raison === "jour" ? echecsJour++ : echecsMax++;
          else nonAtteints++;
        }
        joursReussite.sort((a, c) => a - c);
        return { k, reussite: arr(reussites / P.tirages, 3), echecJour: arr(echecsJour / P.tirages, 3), echecMax: arr(echecsMax / P.tirages, 3),
          nonAtteint: arr(nonAtteints / P.tirages, 3), joursMedian: quantile(joursReussite, 0.5) };
      });
      // Rejeu RÉEL : le challenge lancé chaque jour de l'historique, dans l'ordre exact des trades.
      let reels = 0, reelsOk = 0;
      for (let s = 0; s < n; s++) {
        let i = s;
        const r = jouerChallenge(f, () => (i < n ? jours[i++] : null), 1, n);
        if (r.issue === "fin" || r.issue === "non_atteint") continue; // historique épuisé avant la fin du challenge
        reels++;
        if (r.issue === "reussite") reelsOk++;
      }
      const meilleur = parTaille.reduce((a, c) => (c.reussite > a.reussite ? c : a), parTaille[0]);
      const interdit = f.quickStrike !== undefined && courts30 >= f.quickStrike ? "quick_strike" : null;
      return { id: f.id, nom: f.nom, regles: { phases: f.phases, jour: f.jour, max: f.max, suiveur: f.suiveur, minJours: f.minJours,
        minJoursGagnants: f.minJoursGagnants || 0, meilleurJourMax: f.meilleurJourMax || null, jourSurSoldeDuJour: !!f.jourSurSoldeDuJour,
        selonCompte: !!f.selonCompte, source: f.source },
        parTaille, taille1: parTaille.find((x) => x.k === 1), meilleur: { k: meilleur.k, reussite: meilleur.reussite },
        reel: { departs: reels, reussite: reels >= P.minDepartsReels ? arr(reelsOk / reels, 3) : null }, interdit };
    });
    return { niveau: "ok", tirages: P.tirages, blocJours: b, optimiste: latentes === "alerte" || latentes === "attention", partMoins30s: arr(courts30, 3), firmes };
  }

  // ---------------------------------------------------------------- 4. notes sur 100

  const PLAFOND_RISQUE_CACHE = 40;

  function notes(audit, solid, integ) {
    const c = audit.constats;
    const sec = [];
    const retirer = (cle, pts, si) => { if (si) sec.push({ cle, points: -pts }); };
    retirer("martingale_alerte", 35, c.martingale.niveau === "alerte");
    retirer("martingale_attention", 10, c.martingale.niveau === "attention");
    retirer("grille_alerte", 30, c.grille.niveau === "alerte");
    retirer("grille_attention", 10, c.grille.niveau === "attention");
    retirer("stop_manquant_alerte", 20, c.stop_loss.cle === "stop_manquant" && c.stop_loss.niveau === "alerte");
    retirer("stop_manquant_attention", 10, c.stop_loss.cle === "stop_manquant" && c.stop_loss.niveau === "attention");
    retirer("stop_virtuel", 5, c.stop_loss.cle === "stop_virtuel");
    retirer("profil_alerte", 15, c.profil.niveau === "alerte");
    const lat = integ.constats.find((x) => x.code === "latentes");
    retirer("latentes_alerte", 15, lat && lat.niveau === "alerte");
    retirer("latentes_attention", 5, lat && lat.niveau === "attention");
    // Drawdown d'équité du rapport MT5 ; à défaut, celui du solde (plus optimiste, mais jamais ignoré).
    const ddEq = audit.backtest.stats ? audit.backtest.stats.drawdownEquiteMaxPct : null;
    const dd = ddEq !== null && ddEq !== undefined ? ddEq : integ.ddSolde;
    retirer("drawdown_30", 15, dd >= 0.3);
    retirer("drawdown_20", 8, dd >= 0.2 && dd < 0.3);
    // en % du solde au début de la série (le % du dépôt de départ n'a pas de sens quand le lot suit le solde)
    const ps = audit.extremes && audit.extremes.pireSerie, serie = ps ? (ps.pctSolde !== undefined && ps.pctSolde !== null ? ps.pctSolde : ps.pctDepot) : null;
    retirer("serie_20", 10, serie !== null && serie >= 0.2);
    retirer("compte_ruine", 30, integ.ddSolde >= 1);
    const comportementConnu = ["martingale", "grille", "stop_loss", "profil"].filter((k) => c[k].niveau !== "inconnu").length;
    let securite = comportementConnu ? Math.max(0, 100 + sec.reduce((s, x) => s + x.points, 0)) : null;
    // La note ne contredit jamais le tampon : risque élevé → au plus 49 (« faible »), moyen → au plus 74.
    const plafond = audit.risque === "eleve" ? 49 : audit.risque === "moyen" ? 74 : 100;
    if (securite !== null && securite > plafond) { sec.push({ cle: "plafond_risque_" + audit.risque, points: plafond - securite }); securite = plafond; }

    let solidite = null;
    const sol = [];
    if (solid.niveau === "ok") {
      const gagner = (cle, pts, max) => sol.push({ cle, points: Math.round(pts), max });
      gagner("psr", 25 * borner((solid.psr - 0.5) / 0.45, 0, 1), 25);
      gagner("dsr", 20 * borner((solid.dsr - 0.5) / 0.45, 0, 1), 20);
      gagner("historique", solid.minJours ? 10 * borner(solid.jours / solid.minJours, 0, 1) : 0, 10);
      gagner("stabilite", (15 * solid.tranchesPositives) / solid.tranches.length, 15);
      gagner("dependance", solid.sansTop5pct > 0 ? 15 : solid.sansTop5 > 0 ? 7 : 0, 15);
      gagner("bootstrap", 15 * borner((0.5 - solid.bootstrap.pPerte) / 0.45, 0, 1), 15);
      solidite = sol.reduce((s, x) => s + x.points, 0);
      // Martingale, grille, pertes latentes, « petits gains / grosses pertes » : le risque est dans des pertes
      // RARES, souvent absentes d'un historique d'un an. Les statistiques paraissent alors excellentes à tort
      // (campagne 22/11/2026 : grilles LaboSynth sans avantage notées 100/100). Plafond à 40.
      const cache = c.martingale.niveau === "alerte" || c.grille.niveau === "alerte" || c.profil.niveau === "alerte" || (lat && lat.niveau === "alerte");
      if (cache && solidite > PLAFOND_RISQUE_CACHE) { sol.push({ cle: "plafond_risque_cache", points: PLAFOND_RISQUE_CACHE - solidite }); solidite = PLAFOND_RISQUE_CACHE; }
    }
    const niveau = (x) => (x === null ? "inconnu" : x >= 75 ? "bon" : x >= 50 ? "moyen" : "faible");
    return { securite, niveauSecurite: niveau(securite), detailSecurite: sec, solidite, niveauSolidite: niveau(solidite), detailSolidite: sol };
  }

  // ---------------------------------------------------------------- point d'entrée

  /** audit = résultat de LaboEngine.auditer(backtest). */
  /** barres (facultatif) : cours minute par minute du symbole (lireBarres) → challenges simulés sur l'ÉQUITÉ. */
  function analyser(audit, parametres, barres) {
    const P = Object.assign({}, PARAMS, parametres || {});
    const b = audit.backtest, positions = audit.positions;
    const graine = graineDe(positions);
    const eq = barres && barres.t.length ? equiteMinute(positions, barres, b.depot, b.mouvements) : null;
    const jours = serieJours(positions, b.debut, b.fin, b.depot, b.mouvements, eq && eq.parJour);
    const solid = solidite(jours, positions, b, P, alea(graine));
    const integ = integrite(positions, b, audit, P);
    const prop = challenges(jours, positions, integ, P, alea(graine ^ 0x9e3779b9));
    if (eq) Object.assign(prop, { equiteMinute: true, optimiste: false, ddEquiteMinute: eq.ddEquite, couverture: eq.couverture });
    return { version: 1, graine, solidite: solid, integrite: integ, challenges: prop, notes: notes(audit, solid, integ),
      equite: eq ? { ddEquite: eq.ddEquite, quand: eq.quand, couverture: eq.couverture, barres: eq.barres } : null };
  }

  const api = { analyser, lireBarres, equiteMinute, serieJours, moments, statsSharpe, Phi, PhiInv, alea, jouerPhase, jouerChallenge, FIRMES, PARAMS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LaboAnalyses = api;
})(typeof window !== "undefined" ? window : globalThis);
