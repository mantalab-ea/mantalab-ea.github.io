/*
 * Labo — moteur d'audit (version navigateur).
 * Port fidèle de labo/moteur (Python). Tout s'exécute localement : aucun envoi réseau.
 * Utilisable dans le navigateur (window.LaboEngine) et dans Node (require).
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- utilitaires

  const OPPOSE = { buy: "sell", sell: "buy" };
  const EPS = 1e-9;

  function parseNum(s) {
    if (s === null || s === undefined) return NaN;
    let t = String(s).replace(/[\s  ]/g, "");
    if (t === "") return NaN;
    if (t.indexOf(".") === -1 && t.indexOf(",") !== -1) t = t.replace(",", ".");
    else t = t.replace(/,/g, "");
    return parseFloat(t);
  }

  function parseTime(s) {
    // MT5 : "2024.01.02 10:00:00" ou "2024.01.02 10:00"
    const m = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s).trim());
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  }

  function fmtT(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  // min / max sans « Math.min.apply » : au-delà de ~100 000 valeurs, apply fait déborder la pile (longs historiques)
  const minDe = (t) => t.reduce((a, x) => (x < a ? x : a), Infinity);
  const maxDe = (t) => t.reduce((a, x) => (x > a ? x : a), -Infinity);

  function dayKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------- lecture du rapport MT5

  function decode(buffer) {
    const b = new Uint8Array(buffer);
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b);
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b);
    // UTF-16LE sans BOM : un octet nul sur deux au début
    if (b.length > 8 && b[1] === 0 && b[3] === 0 && b[5] === 0) return new TextDecoder("utf-16le").decode(b);
    return new TextDecoder("utf-8").decode(b);
  }

  function cleanCell(html) {
    return html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/\s+/g, " ")
      .trim();
  }

  function rows(html) {
    const out = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(html))) {
      const cells = [];
      const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let td;
      while ((td = tdRe.exec(tr[1]))) cells.push(cleanCell(td[1]));
      out.push(cells);
    }
    return out;
  }

  const BUY = /^(buy|achat|kauf|compra|acquisto|купля|买入)$/i;
  const SELL = /^(sell|vente|verkauf|venta|vendita|продажа|卖出)$/i;
  const DIR_IN = /^(in|entrée|entree|rein|entrada|entrata|вход)$/i;
  const DIR_OUT = /^(out|sortie|raus|salida|uscita|выход|out by)$/i;
  const DIR_INOUT = /^(in\/out|inout|in out)$/i;

  function sideOf(type) {
    const t = type.trim().toLowerCase();
    if (BUY.test(t)) return "buy";
    if (SELL.test(t)) return "sell";
    if (/^buy\b/.test(t)) return "buy";
    if (/^sell\b/.test(t)) return "sell";
    return null;
  }

  function findStat(allRows, patterns) {
    for (const r of allRows) {
      for (let i = 0; i < r.length - 1; i++) {
        const label = r[i].toLowerCase();
        if (patterns.some((p) => p.test(label))) return r[i + 1];
      }
    }
    return null;
  }

  /**
   * Lit le HTML d'un rapport du testeur MT5.
   * Retourne { backtest, avertissements } ; lève une Error si aucune transaction n'est trouvée.
   */
  function parseMt5Report(html) {
    const allRows = rows(html);
    const avertissements = [];

    // Ordres : 11 cellules, 1re = date. On garde le S/L par numéro d'ordre.
    const slParOrdre = new Map();
    let ordresVus = 0;
    for (const r of allRows) {
      if (r.length === 11 && parseTime(r[0]) !== null && /^\d+$/.test(r[1])) {
        ordresVus++;
        const sl = r[6] === "" ? 0 : parseNum(r[6]);
        slParOrdre.set(r[1], isNaN(sl) ? 0 : sl);
      }
    }

    // Transactions : 13 cellules, 1re = date, 2e = numéro.
    const transactions = [];
    let depot = NaN;
    let directionsInconnues = 0;
    for (const r of allRows) {
      if (r.length !== 13 || parseTime(r[0]) === null || !/^\d+$/.test(r[1])) continue;
      const temps = parseTime(r[0]);
      const symbole = r[2];
      const cote = sideOf(r[3]);
      const profit = parseNum(r[10]) || 0;
      if (!cote || symbole === "") {
        // dépôt initial / crédit / balance
        if (isNaN(depot) && /balance|solde|dépôt|deposit/i.test(r[3]) && profit > 0) depot = profit;
        continue;
      }
      const dirTxt = r[4].trim();
      let entree;
      if (DIR_IN.test(dirTxt)) entree = "in";
      else if (DIR_OUT.test(dirTxt)) entree = "out";
      else if (DIR_INOUT.test(dirTxt)) entree = "inout";
      else {
        directionsInconnues++;
        entree = Math.abs(profit) > EPS ? "out" : "in";
      }
      const tx = {
        temps,
        symbole,
        sens: cote,
        entree,
        volume: parseNum(r[5]),
        prix: parseNum(r[6]),
        ordre: r[7],
        commission: parseNum(r[8]) || 0,
        swap: parseNum(r[9]) || 0,
        profit,
        stopLoss: null,
        commentaire: r[12] || "",
      };
      if (entree === "in" && slParOrdre.has(r[7])) tx.stopLoss = slParOrdre.get(r[7]);
      if (entree === "inout") {
        // retournement (compte netting) : on le traite comme sortie puis entrée du même volume
        transactions.push(Object.assign({}, tx, { entree: "out" }));
        transactions.push(Object.assign({}, tx, { entree: "in", profit: 0, commission: 0, swap: 0 }));
      } else {
        transactions.push(tx);
      }
    }

    if (transactions.length === 0) {
      const err = new Error("Aucune transaction trouvée. Est-ce bien un rapport du testeur de stratégie MetaTrader 5 (fichier .html) ?");
      err.code = "aucune_transaction";
      throw err;
    }
    if (directionsInconnues > 0) avertissements.push({ code: "directions", n: directionsInconnues });
    if (ordresVus === 0) avertissements.push({ code: "ordres" });

    if (isNaN(depot)) {
      const d = parseNum(findStat(allRows, [/initial deposit/, /dépôt initial/, /depot initial/]));
      depot = isNaN(d) ? 10000 : d;
      if (isNaN(d)) avertissements.push({ code: "depot" });
    }

    const stats = {};
    // Drawdown d'équité : MT5 en donne DEUX. « Relative » = le plus grand recul EN POURCENTAGE ; « Maximal » = le plus
    // grand recul en ARGENT (avec son %). On garde le pourcentage le plus grand : un compte déjà entamé qui perd encore
    // la moitié de ce qui reste ne doit pas être noté sur le plus grand montant (LaboSynth XAUUSD sans stop : 54,7 %
    // contre 38,4 % ; vérifié minute par minute le 22/11/2026). Le « Relative » commence par le %, le « Maximal » le met entre ().
    const ddRel = findStat(allRows, [/equity drawdown relative/, /drawdown relatif.*(fonds|équité|equite)/, /drawdown.*(fonds|équité).*relatif/]);
    const ddMax = findStat(allRows, [/equity drawdown maximal/, /drawdown maximal.*(fonds|équité|equite)/, /drawdown.*équité.*maximal/]);
    const pcts = [];
    if (ddRel) { const m = /^\s*([\d.,\s]+)%/.exec(ddRel); if (m) pcts.push(parseNum(m[1]) / 100); }
    if (ddMax) { const m = /\(([\d.,\s]+)%\)/.exec(ddMax); if (m) pcts.push(parseNum(m[1]) / 100); }
    if (pcts.length) stats.drawdownEquiteMaxPct = Math.max(...pcts);

    const temps = transactions.map((t) => t.temps);
    return {
      backtest: {
        robot: findStat(allRows, [/^expert/]) || "Robot",
        symbole: findStat(allRows, [/^symbol/, /^symbole/]) || transactions[0].symbole,
        periode: (findStat(allRows, [/^period/, /^période/]) || "").replace(/\s*\(.*\)\s*$/, ""),
        debut: minDe(temps),
        fin: maxDe(temps),
        depot,
        transactions,
        stats,
        scenario: "rapport fourni",
      },
      avertissements,
    };
  }

  // ---------------------------------------------------------------- historique d'un SIGNAL MQL5 (CSV)

  /**
   * Export « Trading history » d'une page de signal MQL5 (réservé aux membres connectés, format du 22/11/2026) :
   *   Time;Symbol;Type;Direction;Volume;Price;Commission;Swap;Profit;Comment
   *   2026.11.18 03:04:15;XAUUSD;Buy;Out;0.03;3 825.13;-0.11;;14.70;[sl 3825.21]
   *   2024.10.22 16:32:44;;Balance;;;;;;1 615.05;
   * Lignes les plus récentes en premier. Pas de stop-loss d'entrée : seules les clôtures « [sl …] » le révèlent.
   */
  function parseSignalCsv(texte) {
    const lignes = String(texte).replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
    const tete = (lignes[0] || "").split(";").map((x) => x.trim().toLowerCase());
    if (tete.filter((x) => x === "time").length === 2) return parseSignalPositionsCsv(lignes);
    const col = (nom) => tete.indexOf(nom);
    const iT = col("time"), iS = col("symbol"), iTy = col("type"), iD = col("direction"), iV = col("volume"), iP = col("price");
    const iC = col("commission"), iSw = col("swap"), iPr = col("profit"), iCo = col("comment");
    if ([iT, iS, iTy, iD, iV, iP, iPr].some((i) => i < 0)) {
      const err = new Error("Ce fichier CSV n'est pas un historique de signal MQL5 (colonnes Time;Symbol;Type;Direction… attendues).");
      err.code = "csv_inconnu";
      throw err;
    }
    const transactions = [], mouvements = [], avertissements = [];
    let ignorees = 0;
    // du plus ancien au plus récent, en gardant l'ordre du fichier à seconde égale
    for (const l of lignes.slice(1).reverse()) {
      const r = l.split(";");
      const temps = parseTime(r[iT]);
      if (temps === null) { ignorees++; continue; }
      const type = (r[iTy] || "").trim().toLowerCase();
      if (type === "balance" || type === "credit") { mouvements.push({ temps, montant: parseNum(r[iPr]) || 0 }); continue; }
      const dir = (r[iD] || "").trim().toLowerCase();
      if ((type !== "buy" && type !== "sell") || (dir !== "in" && dir !== "out" && dir !== "inout")) { ignorees++; continue; }
      const tx = {
        temps, symbole: (r[iS] || "").trim(), sens: type, entree: dir, volume: parseNum(r[iV]), prix: parseNum(r[iP]),
        commission: iC >= 0 ? parseNum(r[iC]) || 0 : 0, swap: iSw >= 0 ? parseNum(r[iSw]) || 0 : 0, profit: parseNum(r[iPr]) || 0,
        stopLoss: null, commentaire: iCo >= 0 ? (r[iCo] || "").trim().replace(/^\[|\]$/g, "") : "",
      };
      if (dir === "inout") {
        transactions.push(Object.assign({}, tx, { entree: "out" }));
        transactions.push(Object.assign({}, tx, { entree: "in", profit: 0, commission: 0, swap: 0 }));
      } else transactions.push(tx);
    }
    return finSignal(transactions, mouvements, avertissements, ignorees, "transactions");
  }

  /**
   * Export « History » (bouton visible de l'onglet Historique, /export/positions) : une ligne par POSITION.
   *   Time;Type;Volume;Symbol;Price;Volume;Time;Price;Commission;Swap;Profit
   *   2026.11.18 02:23:35;Sell;0.03;XAUUSD;3830.03;0.03;2026.11.18 03:04:15;3825.13;-0.22;;14.7
   *   2024.10.22 16:32:44;Balance;;;;;;;;;1615.05
   * Aucun commentaire : on ne sait pas si une perte s'est fermée sur un stop-loss → stop-loss « inconnu ».
   */
  function parseSignalPositionsCsv(lignes) {
    const transactions = [], mouvements = [], avertissements = [];
    let ignorees = 0;
    for (const l of lignes.slice(1).reverse()) {
      const r = l.split(";");
      const t0 = parseTime(r[0]);
      if (t0 === null) { ignorees++; continue; }
      const type = (r[1] || "").trim().toLowerCase();
      if (type === "balance" || type === "credit") { mouvements.push({ temps: t0, montant: parseNum(r[10]) || 0 }); continue; }
      if (type !== "buy" && type !== "sell") { ignorees++; continue; }
      const sym = (r[3] || "").trim(), v = parseNum(r[2]), t1 = parseTime(r[6] || "");
      transactions.push({ temps: t0, symbole: sym, sens: type, entree: "in", volume: v, prix: parseNum(r[4]), commission: 0, swap: 0, profit: 0, stopLoss: null, commentaire: null });
      if (t1 !== null) {
        const vf = parseNum(r[5]);
        transactions.push({ temps: t1, symbole: sym, sens: type === "buy" ? "sell" : "buy", entree: "out", volume: isNaN(vf) ? v : vf, prix: parseNum(r[7]),
          commission: parseNum(r[8]) || 0, swap: parseNum(r[9]) || 0, profit: parseNum(r[10]) || 0, stopLoss: null, commentaire: null });
      }
    }
    return finSignal(transactions, mouvements, avertissements, ignorees, "positions");
  }

  /** Fin commune aux deux exports : dépôt initial, mouvements, symbole principal, avertissements. */
  function finSignal(transactions, mouvements, avertissements, ignorees, format) {
    if (!transactions.length) {
      const err = new Error("Aucune transaction dans cet historique de signal.");
      err.code = "aucune_transaction";
      throw err;
    }
    if (ignorees) avertissements.push({ code: "lignes_ignorees", n: ignorees });
    mouvements.sort((a, b) => a.temps - b.temps); // le dépôt initial = le PREMIER mouvement dans le temps, quel que soit l'ordre du fichier
    const depot = mouvements.length && mouvements[0].montant > 0 ? mouvements[0].montant : NaN;
    if (isNaN(depot)) avertissements.push({ code: "depot" });
    const suivants = mouvements.slice(isNaN(depot) ? 0 : 1).filter((m) => m.montant);
    if (suivants.length) avertissements.push({ code: "mouvements", n: suivants.length, total: suivants.reduce((a, m) => a + m.montant, 0) });
    if (format === "positions") avertissements.push({ code: "export_positions" });
    const parSymbole = {};
    transactions.forEach((t) => (parSymbole[t.symbole] = (parSymbole[t.symbole] || 0) + 1));
    const symboles = Object.keys(parSymbole).sort((a, b) => parSymbole[b] - parSymbole[a]);
    const temps = transactions.map((t) => t.temps);
    return {
      backtest: {
        robot: "Signal MQL5", source: "signal", format, clotureInconnue: format === "positions",
        symbole: symboles.length > 1 ? `${symboles[0]} +${symboles.length - 1}` : symboles[0],
        periode: "", debut: minDe(temps), fin: maxDe(temps),
        depot: isNaN(depot) ? 10000 : depot, mouvements: suivants, transactions, stats: {}, scenario: "signal réel",
      },
      avertissements,
    };
  }

  // ---------------------------------------------------------------- reconstruction des positions (FIFO)

  function reconstruirePositions(transactions) {
    const tx = transactions.slice().sort((a, b) => a.temps - b.temps);
    const resultat = [];
    let ouvertes = [];
    for (const t of tx) {
      if (t.entree === "in") {
        const p = {
          symbole: t.symbole, sens: t.sens, volume: t.volume, prixEntree: t.prix,
          ouverture: t.temps, fermeture: null, prixSortie: null,
          profit: (t.commission || 0) + (t.swap || 0), stopLoss: t.stopLoss, fermeParSL: false,
        };
        resultat.push(p);
        ouvertes.push({ p, reste: t.volume });
        continue;
      }
      let aFermer = t.volume;
      const total = (t.profit || 0) + (t.commission || 0) + (t.swap || 0);
      for (const o of ouvertes) {
        if (aFermer <= EPS) break;
        if (o.p.symbole !== t.symbole || o.p.sens !== OPPOSE[t.sens] || o.reste <= EPS) continue;
        const pris = Math.min(o.reste, aFermer);
        const part = t.volume ? pris / t.volume : 1;
        o.reste -= pris;
        aFermer -= pris;
        o.p.profit += total * part;
        if (o.reste <= EPS) {
          o.p.fermeture = t.temps;
          o.p.prixSortie = t.prix;
          // clôture par le stop-loss du COURTIER (commentaire MT5 « sl 1.14918 »)
          o.p.fermeParSL = /^sl\b/i.test(t.commentaire || "");
        }
      }
      ouvertes = ouvertes.filter((o) => o.reste > EPS);
    }
    return resultat;
  }

  // ---------------------------------------------------------------- détecteurs

  const REGLAGES = {
    ratioMartingale: 1.5, ratioGrilleMartingale: 1.25, minEvenementsMartingale: 3, partMartingaleAlerte: 0.3, chaineMartingaleAlerte: 3,
    maxPositionsGrilleAlerte: 3, minEntreesGrille: 3,
    partSansStopAlerte: 0.5, partSansStopAttention: 0.1,
    minPertesStopVirtuel: 10, toleranceStopVirtuel: 0.15, partStopVirtuel: 0.7,
    partPlafondStop: 0.3, partAuDelaPlafond: 0.05, partRenfortsAttention: 0.02,
    fenetrePanierSecondes: 2,
    partRenfortsAlerte: 0.15, partStopPoseApres: 0.25, partPileStop: 0.1, densitePileStop: 2, partAuDelaGaps: 0.2,
    dureeCourteSecondes: 60, partCourteAlerte: 0.3, partCourteAttention: 0.05,
    tauxReussiteSuspect: 0.85, ratioPerteGainSuspect: 3.0,
    perteJourMax: 0.05, perteTotaleMax: 0.10, minPositions: 20,
  };

  const fermee = (p) => p.fermeture !== null;
  const pct = (x) => `${Math.round(x * 100)} %`;
  const g = (x) => +x.toFixed(4) + "";

  function pasAssez(code, n) {
    return { code, niveau: "inconnu", cle: "pas_assez", donnees: { n }, mesures: {}, exemples: [] };
  }

  /**
   * PANIERS : positions du même symbole et du même sens ouvertes à au plus r.fenetrePanierSecondes (2 s) de la
   * première = UNE décision, découpée en plusieurs ordres (0,01 + 0,02 + 0,03…). Sans ce regroupement, un vrai
   * signal (Gold Reaper, 22/11/2026 : 212 entrées sur 575 sont des paniers de 2 à 7 positions) passait pour une
   * martingale et une grille. Volume et profit additionnés ; prix d'entrée moyen pondéré ; fermé quand tout l'est.
   */
  function regrouperPaniers(positions, r) {
    const fenetre = r.fenetrePanierSecondes * 1000;
    const tri = positions.slice().sort((a, b) => a.ouverture - b.ouverture);
    const courant = new Map(), res = [];
    for (const p of tri) {
      const cle = p.symbole + "|" + p.sens, b = courant.get(cle);
      if (fenetre > 0 && b && p.ouverture - b.ouverture <= fenetre) {
        b.prixEntree = (b.prixEntree * b.volume + p.prixEntree * p.volume) / (b.volume + p.volume);
        b.volume = +(b.volume + p.volume).toFixed(8);
        b.profit += p.profit;
        b.fermeture = b.fermeture === null || p.fermeture === null ? null : Math.max(b.fermeture, p.fermeture);
        b.n++;
        continue;
      }
      const nb = Object.assign({}, p, { n: 1 });
      courant.set(cle, nb);
      res.push(nb);
    }
    return res;
  }

  /**
   * Après une perte FERMÉE, la position suivante du MÊME symbole est-elle plus grosse ? Même symbole : sur un signal
   * multi-marchés, 1 lot d'indice après 0,01 lot d'or n'est pas une martingale (signal 2376856 : « ×10 000 »).
   * Un DÉPÔT entre la perte et la position suivante : pas de comparaison (le robot grossit avec le compte).
   */
  function detecterMartingale(positions, r, unitaires, depots) {
    const fermees = positions.filter(fermee);
    if (fermees.length < r.minPositions) return pasAssez("martingale", fermees.length);
    const parOuverture = positions.slice().sort((a, b) => a.ouverture - b.ouverture);
    const fermeesParSymbole = new Map();
    for (const p of fermees.slice().sort((a, b) => a.fermeture - b.fermeture)) {
      if (!fermeesParSymbole.has(p.symbole)) fermeesParSymbole.set(p.symbole, []);
      fermeesParSymbole.get(p.symbole).push(p);
    }
    const curseur = new Map(), derniereParSymbole = new Map();
    const dep = (depots || []).slice().sort((a, b) => a - b);
    const depotEntre = (t0, t1) => dep.some((t) => t > t0 && t <= t1);
    let apresPerte = 0, hausses = 0, chaine = 0, chaineMax = 0;
    const exemples = [];
    const u = unitaires || positions; // plus grosse / plus petite POSITION (pas panier) pour le texte
    const vMin = minDe(u.map((p) => p.volume));
    // Hausse d'UN seul cran de 0,01 lot (0,01 → 0,02) chez un robot qui trade au lot minimum : arrondi d'un lot qui
    // suit le solde, pas une martingale (signaux réels du 22/11/2026). Au-dessus de 0,01 lot, ce cran n'existe pas.
    const cran = vMin <= 0.01 + EPS ? 0.01 : 0;
    const mult = vMin ? maxDe(u.map((p) => p.volume)) / vMin : 1;
    for (const p of parOuverture) {
      const liste = fermeesParSymbole.get(p.symbole) || [];
      let i = curseur.get(p.symbole) || 0, derniere = derniereParSymbole.get(p.symbole) || null;
      while (i < liste.length && liste[i].fermeture <= p.ouverture) derniere = liste[i++];
      curseur.set(p.symbole, i);
      derniereParSymbole.set(p.symbole, derniere);
      if (!derniere || depotEntre(derniere.fermeture, p.ouverture)) continue;
      if (derniere.profit < 0) {
        apresPerte++;
        if (p.volume >= derniere.volume * r.ratioMartingale - EPS) {
          // la CHAÎNE compte toute hausse (0,01 → 0,02 → 0,04… est une martingale) ; le décompte isolé ignore un seul cran
          chaine++; chaineMax = Math.max(chaineMax, chaine);
          if (p.volume - derniere.volume > cran + EPS) {
            hausses++;
            if (exemples.length < 3) exemples.push({ t: p.ouverture, perte: derniere.profit, v0: derniere.volume, v1: p.volume });
          }
        } else chaine = 0;
      } else chaine = 0;
    }
    const part = apresPerte ? hausses / apresPerte : 0;
    const mesures = { apresPerte, hausses, part: +part.toFixed(3), chaineMax, mult: +mult.toFixed(2) };
    const alerte = (hausses >= r.minEvenementsMartingale && part >= r.partMartingaleAlerte) || chaineMax >= r.chaineMartingaleAlerte;
    // « à surveiller » dès 3 hausses (comme la grille) : 1 ou 2 = anecdotique (EMA Cross : 2 sur 47, ordres en attente
    // déclenchés ensemble par un gap ; étalonnage du 22/11/2026).
    const niveau = alerte ? "alerte" : hausses >= r.minEvenementsMartingale ? "attention" : "ok";
    return { code: "martingale", niveau, cle: "martingale_" + niveau, donnees: mesures, mesures, exemples };
  }

  function detecterGrille(positions, r) {
    if (positions.length < r.minPositions) return pasAssez("grille", positions.length);
    const ev = [];
    // À temps égal : fermetures, puis positions ouvertes ET fermées dans la même seconde (ouverture
    // avant fermeture), puis ouvertures. Campagne 2026-11-21 : sans ça, une position de durée 0 n'était
    // jamais retirée et un scalpeur passait pour une grille (NZDUSD : 5 positions « simultanées »).
    positions.forEach((p) => {
      const nulle = fermee(p) && p.fermeture === p.ouverture;
      ev.push({ t: p.ouverture, o: nulle ? 0.5 : 1, ouvre: true, p });
      if (fermee(p)) ev.push({ t: p.fermeture, o: nulle ? 0.75 : 0, ouvre: false, p });
    });
    ev.sort((a, b) => a.t - b.t || a.o - b.o);
    const ouvertes = new Map();
    let simMax = 0, defav = 0, hausses = 0;
    const exemples = [], exemplesHausse = [];
    for (const e of ev) {
      const cle = e.p.symbole + "|" + e.p.sens;
      if (!ouvertes.has(cle)) ouvertes.set(cle, []);
      const deja = ouvertes.get(cle);
      if (!e.ouvre) {
        const k = deja.indexOf(e.p);
        if (k >= 0) deja.splice(k, 1);
        continue;
      }
      if (deja.length) {
        const d = deja[deja.length - 1];
        const pire = e.p.sens === "buy" ? e.p.prixEntree < d.prixEntree : e.p.prixEntree > d.prixEntree;
        if (pire) {
          defav++;
          // ×1,25 et non ×1,5 : l'arrondi des lots transforme une grille ×1,5 en 0,15 → 0,22 (×1,47) ; une grille plate = ×1,00
          if (e.p.volume >= d.volume * r.ratioGrilleMartingale - EPS) {
            hausses++;
            if (exemplesHausse.length < 3) exemplesHausse.push({ t: e.p.ouverture, rang: deja.length + 1, v0: d.volume, v1: e.p.volume, symbole: e.p.symbole });
          }
          if (exemples.length < 3) exemples.push({ t: e.p.ouverture, rang: deja.length + 1, sens: e.p.sens, symbole: e.p.symbole, prix: e.p.prixEntree, avant: d.prixEntree });
        }
      }
      deja.push(e.p);
      simMax = Math.max(simMax, deja.length);
    }
    const mesures = { simMax, defav, hausses };
    let niveau = "ok";
    if (simMax >= r.maxPositionsGrilleAlerte && defav >= r.minEntreesGrille) niveau = "alerte";
    // Moyenne à la baisse SYSTÉMATIQUE même sans 3 positions empilées : le panier se ferme dès le 2e
    // niveau (campagne 2026-11-21 : grilles LaboSynth sur actions, 35-45 % des positions sont des renforts).
    else if (simMax >= 2 && defav >= r.minEntreesGrille && defav / positions.length >= r.partRenfortsAlerte) niveau = "alerte";
    // « à surveiller » : au moins minEntreesGrille renforts. Étalonnage 2026-11-21 : Crossing MA (robot propre,
    // lot fixe, SL) fait 2 renforts en 87 positions par simple répétition de signal → ne doit pas être signalé.
    // + proportion : un scalpeur qui chevauche 374 positions sur 55 123 (0,7 %) n'est pas une grille.
    else if (simMax >= 2 && defav >= r.minEntreesGrille && defav / positions.length >= r.partRenfortsAttention) niveau = "attention";
    return { code: "grille", niveau, cle: "grille_" + niveau, donnees: mesures, mesures, exemples, exemplesHausse };
  }

  function detecterStopLoss(positions, r, clotureInconnue) {
    const connues = positions.filter((p) => p.stopLoss !== null && p.stopLoss !== undefined);
    if (!connues.length) return clotureInconnue
      ? { code: "stop_loss", niveau: "inconnu", cle: "stop_export_positions", donnees: {}, mesures: {}, exemples: [] }
      : stopDeduit(positions, r);
    const sans = connues.filter((p) => !(p.stopLoss > 0));
    const part = sans.length / connues.length;
    let niveau = part >= r.partSansStopAlerte ? "alerte" : part >= r.partSansStopAttention ? "attention" : "ok";
    const mesures = { sans: sans.length, part: +part.toFixed(3) };
    const exemples = sans.slice(0, 3).map((p) => ({ t: p.ouverture, sens: p.sens, v: p.volume }));
    let cle = "stop_" + (niveau === "ok" ? "ok" : "manquant");
    if (niveau !== "ok") {
      // Stop posé juste APRÈS l'ouverture (absent de l'ordre d'entrée) : les pertes se ferment
      // par le stop du courtier. Étalonnage 2026-11-21 : VR Overturn.
      const pertes = sans.filter((p) => fermee(p) && p.profit < 0);
      const parSL = pertes.filter((p) => p.fermeParSL).length;
      // Une clôture « sl » est impossible sans stop chez le courtier : un quart des pertes suffit (sur actions,
      // beaucoup de pertes sortent au temps ; campagne 2026-11-21 : AAPL 106/183).
      if (pertes.length >= r.minPertesStopVirtuel && parSL >= r.minPertesStopVirtuel && parSL / pertes.length >= r.partStopPoseApres) {
        Object.assign(mesures, { poseApres: true, pertesParSL: parSL, pertes: pertes.length, partParSL: +(parSL / pertes.length).toFixed(3) });
        return { code: "stop_loss", niveau: "ok", cle: "stop_pose_apres", donnees: mesures, mesures, exemples: [] };
      }
      const v = stopVirtuel(sans, r);
      if (v) {
        // Le robot coupe lui-même ses pertes à distance fixe : protection réelle, mais invisible
        // pour le courtier (rien ne protège la position si le terminal s'arrête).
        niveau = "attention";
        cle = "stop_virtuel";
        Object.assign(mesures, v);
        exemples.forEach((e) => (e.virtuel = true));
      }
    }
    return { code: "stop_loss", niveau, cle, donnees: mesures, mesures, exemples };
  }

  /**
   * Stop d'entrée INCONNU (historique de signal MQL5) : on le déduit des clôtures. Une perte fermée « sl » prouve un
   * stop chez le courtier ; aucune sur de nombreuses pertes = probablement aucun stop (ou un stop virtuel).
   */
  function stopDeduit(positions, r) {
    const pertes = positions.filter((p) => fermee(p) && p.profit < 0);
    const vide = { code: "stop_loss", niveau: "inconnu", cle: "stop_inconnu", donnees: {}, mesures: {}, exemples: [] };
    if (pertes.length < r.minPertesStopVirtuel) return vide;
    const parSL = pertes.filter((p) => p.fermeParSL).length;
    const mesures = { deduit: true, pertes: pertes.length, pertesParSL: parSL, partParSL: +(parSL / pertes.length).toFixed(3) };
    if (parSL >= r.minPertesStopVirtuel && parSL / pertes.length >= r.partStopPoseApres)
      return { code: "stop_loss", niveau: "ok", cle: "stop_constate", donnees: mesures, mesures, exemples: [] };
    const v = stopVirtuel(positions, r);
    if (v) {
      Object.assign(mesures, v, { part: 1 - parSL / pertes.length });
      return { code: "stop_loss", niveau: "attention", cle: "stop_virtuel", donnees: mesures, mesures, exemples: [] };
    }
    if (parSL === 0) {
      const exemples = pertes.slice().sort((a, b) => a.profit - b.profit).slice(0, 3).map((p) => ({ t: p.ouverture, sens: p.sens, v: p.volume, perte: p.profit }));
      return { code: "stop_loss", niveau: "alerte", cle: "stop_absent_probable", donnees: mesures, mesures, exemples };
    }
    return { code: "stop_loss", niveau: "attention", cle: "stop_partiel", donnees: mesures, mesures, exemples: [] };
  }

  /** Pertes des positions sans stop, regroupées autour d'une même distance de prix ? */
  function stopVirtuel(sansStop, r) {
    const d = sansStop
      .filter((p) => fermee(p) && p.profit < 0 && p.prixSortie !== null)
      .map((p) => Math.abs(p.prixSortie - p.prixEntree))
      .sort((a, b) => a - b);
    if (d.length < r.minPertesStopVirtuel) return null;
    const n = d.length;
    const med = n % 2 ? d[(n - 1) / 2] : (d[n / 2 - 1] + d[n / 2]) / 2;
    if (!(med > 0)) return null;
    // Signature d'un stop : un PLAFOND. Les pertes s'empilent à une distance maximale qu'elles ne
    // dépassent (presque) jamais, même si d'autres pertes plus petites existent (sorties au temps,
    // signal inverse…). Étalonnage 2026-11-21 : la règle « 70 % autour de la médiane » ratait ces robots.
    // d est trié : nombre de y dans [x(1-t), x(1+t)] par recherche dichotomique (O(n log n)).
    const borne = (v, strict) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (strict ? d[m] <= v : d[m] < v) lo = m + 1; else hi = m; } return lo; };
    let plafond = 0, proches = 0;
    for (const x of d) {
      if (x <= 0) continue;
      const t = r.toleranceStopVirtuel * x;
      const k = borne(x + t, true) - borne(x - t, false);
      if (k > proches || (k === proches && x > plafond)) { plafond = x; proches = k; }
    }
    const auDela = d.filter((y) => y > plafond * (1 + 2 * r.toleranceStopVirtuel)).length;
    const part = proches / n;
    const estPlafond = plafond >= med && part >= r.partPlafondStop && auDela / n <= r.partAuDelaPlafond;
    // Pile au plafond : moins de pertes au plafond (beaucoup de sorties au temps), mais nettement plus
    // dans la bande du plafond que juste en dessous — une queue de pertes sans stop décroît au contraire.
    const t = r.toleranceStopVirtuel;
    const dessous = borne(plafond * (1 - t), false) - borne(plafond * (1 - 3 * t), false);
    const pile = proches >= r.minPertesStopVirtuel && proches >= r.densitePileStop * Math.max(dessous, 1);
    const estPile = plafond >= med && pile && part >= r.partPileStop && auDela / n <= r.partAuDelaPlafond;
    // Pile très nette mais dépassée par des écarts (gaps d'ouverture sur actions : le stop virtuel
    // ne s'exécute qu'au prix suivant). Campagne 2026-11-21 : AAPL, MSFT, NVDA, AMZN à 300 points.
    const estPileGaps = plafond >= med && pile && part >= r.partPlafondStop && auDela / n <= r.partAuDelaGaps;
    if (part < r.partStopVirtuel && !(estPlafond && proches >= r.minPertesStopVirtuel) && !estPile && !estPileGaps) return null;
    const ref = part >= r.partStopVirtuel ? med : plafond;
    // Points estimés d'après le niveau de prix (5 décimales < 10, 3 décimales < 1000, sinon 2).
    const prix = sansStop[0].prixEntree;
    const point = prix < 10 ? 1e-5 : prix < 1000 ? 1e-3 : 1e-2;
    return { virtuel: true, distance: +ref.toFixed(6), points: Math.round(ref / point), pertesProches: proches, pertes: n, partProches: +part.toFixed(3) };
  }

  function detecterTradesCourts(positions, r) {
    const fermees = positions.filter(fermee);
    if (fermees.length < r.minPositions) return pasAssez("trades_courts", fermees.length);
    const courts = fermees.filter((p) => (p.fermeture - p.ouverture) / 1000 < r.dureeCourteSecondes);
    const part = courts.length / fermees.length;
    const niveau = part >= r.partCourteAlerte ? "alerte" : part >= r.partCourteAttention ? "attention" : "ok";
    const mesures = { courts: courts.length, part: +part.toFixed(3), seuil: r.dureeCourteSecondes };
    return { code: "trades_courts", niveau, cle: "courts_" + niveau, donnees: mesures, mesures, exemples: [] };
  }

  function detecterProfil(positions, r) {
    const fermees = positions.filter(fermee);
    if (fermees.length < r.minPositions) return pasAssez("profil", fermees.length);
    const gains = fermees.filter((p) => p.profit > 0).map((p) => p.profit);
    const pertes = fermees.filter((p) => p.profit < 0).map((p) => -p.profit);
    const somme = (a) => a.reduce((x, y) => x + y, 0);
    const taux = gains.length / fermees.length;
    const gm = gains.length ? somme(gains) / gains.length : 0;
    const pm = pertes.length ? somme(pertes) / pertes.length : 0;
    const ratio = gm ? pm / gm : 0;
    const mesures = { taux: +taux.toFixed(3), gainMoyen: +gm.toFixed(2), perteMoyenne: +pm.toFixed(2), ratio: +ratio.toFixed(2), pire: pertes.length ? +maxDe(pertes).toFixed(2) : 0 };
    const niveau = taux >= r.tauxReussiteSuspect && ratio >= r.ratioPerteGainSuspect ? "alerte" : "ok";
    return { code: "profil", niveau, cle: "profil_" + niveau, donnees: mesures, mesures, exemples: [] };
  }

  function detecterReglesProp(positions, depot, r, ddPlateforme) {
    const fermees = positions.filter(fermee).sort((a, b) => a.fermeture - b.fermeture);
    if (!fermees.length) return pasAssez("prop", 0);
    let solde = depot, plusBas = depot;
    const pnlJour = new Map(), debutJour = new Map();
    for (const p of fermees) {
      const j = dayKey(p.fermeture);
      if (!debutJour.has(j)) debutJour.set(j, solde);
      pnlJour.set(j, (pnlJour.get(j) || 0) + p.profit);
      solde += p.profit;
      plusBas = Math.min(plusBas, solde);
    }
    let pireJour = null, pirePerte = 0, joursHors = 0;
    for (const [j, pnl] of pnlJour) {
      const x = debutJour.get(j) ? -pnl / debutJour.get(j) : 0;
      if (x > pirePerte) { pireJour = j; pirePerte = x; }
      if (x >= r.perteJourMax) joursHors++;
    }
    const perteTotale = depot ? (depot - plusBas) / depot : 0;
    const mesures = { pirePerteJour: +pirePerte.toFixed(4), joursHors, perteTotale: +perteTotale.toFixed(4) };
    if (ddPlateforme !== undefined && ddPlateforme !== null) mesures.ddEquite = +ddPlateforme.toFixed(4);
    const problemes = [];
    if (pirePerte >= r.perteJourMax) problemes.push({ type: "jour", pct: pirePerte, jour: pireJour, limite: r.perteJourMax });
    if (perteTotale >= r.perteTotaleMax) problemes.push({ type: "total", pct: perteTotale, limite: r.perteTotaleMax });
    if (mesures.ddEquite !== undefined && mesures.ddEquite >= r.perteTotaleMax) problemes.push({ type: "equite", pct: mesures.ddEquite, limite: r.perteTotaleMax });
    const niveau = problemes.length ? "alerte" : "ok";
    return { code: "prop", niveau, cle: "prop_" + niveau, donnees: { problemes, avecEquite: mesures.ddEquite !== undefined }, mesures, exemples: [] };
  }

  // ---------------------------------------------------------------- scénarios extrêmes observés

  /** Pire série de pertes consécutives et exposition maximale (lots ouverts en même temps). */
  function extremes(positions, depot) {
    const fermees = positions.filter(fermee).sort((a, b) => a.fermeture - b.fermeture);
    let n = 0, cumul = 0, pire = { n: 0, perte: 0, debut: null, fin: null }, debutSerie = null;
    for (const p of fermees) {
      if (p.profit < 0) {
        if (n === 0) debutSerie = p.ouverture;
        n++; cumul += p.profit;
        if (cumul < pire.perte || (cumul === pire.perte && n > pire.n)) pire = { n, perte: cumul, debut: debutSerie, fin: p.fermeture };
      } else { n = 0; cumul = 0; }
    }
    const ev = [];
    positions.forEach((p) => { ev.push([p.ouverture, 1, p.volume]); if (fermee(p)) ev.push([p.fermeture, 0, -p.volume]); });
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let ouvert = 0, expo = 0, quand = null, simult = 0, simMax = 0;
    for (const [t, o, v] of ev) {
      ouvert += v; simult += o ? 1 : -1;
      if (ouvert > expo + EPS) { expo = ouvert; quand = t; }
      simMax = Math.max(simMax, simult);
    }
    const vMin = positions.length ? minDe(positions.map((p) => p.volume)) : 0;
    return {
      pireSerie: { pertes: pire.n, montant: +pire.perte.toFixed(2), pctDepot: depot ? +(-pire.perte / depot).toFixed(4) : null, debut: pire.debut, fin: pire.fin },
      expositionMax: { lots: +expo.toFixed(2), foisMiseMin: vMin ? +(expo / vMin).toFixed(1) : null, quand, positionsSimultanees: simMax },
    };
  }

  // ---------------------------------------------------------------- audit + verdict

  function auditer(backtest, reglages) {
    const r = Object.assign({}, REGLAGES, reglages || {});
    const positions = reconstruirePositions(backtest.transactions);
    const paniers = regrouperPaniers(positions, r);
    const dd = backtest.stats ? backtest.stats.drawdownEquiteMaxPct : undefined;
    const liste = [
      detecterMartingale(paniers, r, positions, (backtest.mouvements || []).filter((m) => m.montant > 0).map((m) => m.temps)),
      detecterGrille(paniers, r),
      detecterStopLoss(positions, r, !!backtest.clotureInconnue),
      detecterTradesCourts(positions, r),
      detecterProfil(positions, r),
      detecterReglesProp(positions, backtest.depot, r, dd),
    ];
    const c = {};
    liste.forEach((x) => (c[x.code] = x));
    // Martingale « de grille » : la mise grossit à chaque renfort d'une position perdante encore ouverte
    // (le détecteur classique ne regarde que la position qui suit une perte FERMÉE). Proportion exigée :
    // étalonnage 2026-11-21, BGC Grid (lot qui suit l'équité) = 27 renforts plus gros sur 3 301 (0,8 %).
    const gm = c.grille.mesures || {};
    if (c.martingale.niveau !== "alerte" && c.martingale.niveau !== "inconnu" && gm.hausses >= r.minEvenementsMartingale && gm.hausses / gm.defav >= r.partMartingaleAlerte) {
      const m = Object.assign({}, c.martingale.mesures, { haussesGrille: gm.hausses, defav: gm.defav });
      c.martingale = { code: "martingale", niveau: "alerte", cle: "martingale_grille", donnees: m, mesures: m, exemples: c.grille.exemplesHausse };
      liste[liste.findIndex((x) => x.code === "martingale")] = c.martingale;
    }
    const comportement = ["martingale", "grille", "stop_loss", "profil"].map((k) => c[k]);
    let risque;
    if (comportement.every((x) => x.niveau === "inconnu")) risque = "inconnu";
    else if (c.martingale.niveau === "alerte" || c.grille.niveau === "alerte") risque = "eleve";
    else if (c.stop_loss.niveau === "alerte" && c.profil.niveau === "alerte") risque = "eleve";
    else if (comportement.some((x) => x.niveau === "alerte" || x.niveau === "attention")) risque = "moyen";
    else risque = "faible";
    let compatibleProp = null;
    const raisonsProp = ["prop", "trades_courts", "martingale", "grille"].filter((k) => c[k].niveau === "alerte");
    if (c.prop.niveau !== "inconnu") compatibleProp = raisonsProp.length === 0;
    const fermees = positions.filter(fermee);
    return {
      backtest, positions, paniers: paniers.length, constats: c, risque, compatibleProp, raisonsProp,
      detectes: liste.filter((x) => x.niveau === "alerte").map((x) => x.code).sort(),
      resume: { positions: positions.length, fermees: fermees.length, net: fermees.reduce((s, p) => s + p.profit, 0) },
      extremes: extremes(positions, backtest.depot),
    };
  }

  const api = { parseMt5Report, parseSignalCsv, decode, reconstruirePositions, regrouperPaniers, auditer, REGLAGES, fmtT, parseNum, parseTime, _rows: rows };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LaboEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
