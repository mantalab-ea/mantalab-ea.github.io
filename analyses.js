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
    { id: "the5ers_hs", nom: "The5ers High Stakes", phases: [0.10, 0.05], jour: 0.05, max: 0.10, suiveur: false, minJours: 0,
      minJoursGagnants: 3, seuilJourGagnant: 0.005, nonConfirme: true, source: "the5ers.com/high-stakes" },
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
  function serieJours(positions, debut, fin, depot) {
    const pnl = new Map(), ouv = new Map();
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
      jours.push({ k, pnl: g, r, ouvertes: o });
      solde += g;
    }
    return jours;
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
    const partMeilleureTranche = net > 0 ? Math.max(...tranches.map((t) => t.net)) / net : null;

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
    let solde = backtest.depot, pic = solde, ddSolde = 0;
    for (const p of fermees) { solde += p.profit; if (solde > pic) pic = solde; if (pic > 0) ddSolde = Math.max(ddSolde, 1 - solde / pic); }
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
      if (solde <= debut - f.jour) return { issue: "echec", raison: "jour", jours };
      const plancher = f.suiveur ? Math.max(plusHautFinJour, 1) - f.max : 1 - f.max;
      if (solde <= plancher) return { issue: "echec", raison: "max", jours };
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
        minJoursGagnants: f.minJoursGagnants || 0, meilleurJourMax: f.meilleurJourMax || null, nonConfirme: !!f.nonConfirme, source: f.source },
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
    const serie = audit.extremes && audit.extremes.pireSerie ? audit.extremes.pireSerie.pctDepot : null;
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
  function analyser(audit, parametres) {
    const P = Object.assign({}, PARAMS, parametres || {});
    const b = audit.backtest, positions = audit.positions;
    const graine = graineDe(positions);
    const jours = serieJours(positions, b.debut, b.fin, b.depot);
    const solid = solidite(jours, positions, b, P, alea(graine));
    const integ = integrite(positions, b, audit, P);
    const prop = challenges(jours, positions, integ, P, alea(graine ^ 0x9e3779b9));
    return { version: 1, graine, solidite: solid, integrite: integ, challenges: prop, notes: notes(audit, solid, integ) };
  }

  const api = { analyser, serieJours, moments, statsSharpe, Phi, PhiInv, alea, jouerPhase, jouerChallenge, FIRMES, PARAMS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LaboAnalyses = api;
})(typeof window !== "undefined" ? window : globalThis);
