/*
 * Labo — moteur d'audit (version navigateur).
 * LE moteur de MantaLab (site, labo, fiches, base) : il n'y en a pas d'autre. Tout s'exécute localement : aucun envoi réseau.
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
    // Totaux calculés par MetaTrader lui-même : servent à vérifier NOTRE lecture du rapport (contrôle de cohérence)
    const netMT5 = parseNum(findStat(allRows, [/^total net profit/, /^bénéfice net total/, /^profit net total/]));
    const tradesMT5 = parseNum(findStat(allRows, [/^total trades/, /^total des trades/, /^nombre total de trades/]));
    const dealsMT5 = parseNum(findStat(allRows, [/^total deals/, /^total des transactions/]));
    if (!isNaN(netMT5)) stats.netMT5 = netMT5;
    if (!isNaN(tradesMT5)) stats.tradesMT5 = tradesMT5;
    if (!isNaN(dealsMT5)) stats.dealsMT5 = dealsMT5;

    // Réglages EXACTS du robot pendant le test (section « Inputs » de l'en-tête) + courtier, build, qualité de l'historique :
    // la preuve de ce qui a été testé (26/11/2026). Lignes « ==== TITRE ==== » = groupes, sans valeur.
    const reglages = [];
    let dansInputs = false;
    for (const r of allRows) {
      if (r.length === 2 && /^(inputs|paramètres d'entrée|parametres d'entree|entrées)\s*:?$/i.test(r[0])) dansInputs = true;
      else if (dansInputs && (r.length !== 2 || r[0] !== "")) dansInputs = false;
      if (!dansInputs) continue;
      const v = r[1] || "", i = v.indexOf("=");
      if (i > 0) reglages.push({ nom: v.slice(0, i).trim(), valeur: v.slice(i + 1).trim() });
      else if (v.trim()) reglages.push({ groupe: v.replace(/=+/g, "").trim() });
    }
    const contexte = { serveur: (allRows[1] && allRows[1][0]) || null, societe: findStat(allRows, [/^company/, /^société/]),
      qualiteHistorique: findStat(allRows, [/^history quality/, /^qualité de l'historique/]), levier: findStat(allRows, [/^leverage/, /^effet de levier/]) };

    const temps = transactions.map((t) => t.temps);
    return {
      backtest: {
        reglages, contexte,
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
          profit: (t.commission || 0) + (t.swap || 0), stopLoss: t.stopLoss, fermeParSL: false, commentaire: t.commentaire || "",
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
    // moteur v2 (26/11/2026) : décisions, causalité perte → hausse, renforts sans stop (voir construireDecisions)
    fenetreDecisionSecondes: 60,
    ratioMartingale: 1.45, ratioGrilleMartingale: 1.25, minEvenementsMartingale: 3,
    minPertesMartingale: 10, partMartingaleAlerte: 0.4, ecartMartingaleAlerte: 0.3, partMartingaleAttention: 0.2, ecartMartingaleAttention: 0.15, rapportTailleMartingaleAlerte: 1.6, ecartMartingaleAttention2: 0.1, rapportTailleMartingaleAttention: 1.3,
    minEntreesGrille: 5, minRenfortsGrilleAlerte: 10, pileGrilleAlerte: 5, stopLointainFois: 5, risqueStopMax: 0.25, partRenfortsPanier: 0.8, partStopsTouchesMin: 0.05, partRenfortsNonProteges: 0.5, partGrilleMartingale: 0.3,
    partSansStopAlerte: 0.5, partSansStopAttention: 0.1,
    minPertesStopVirtuel: 10, toleranceStopVirtuel: 0.15, partStopVirtuel: 0.7,
    partPlafondStop: 0.3, partAuDelaPlafond: 0.05, partRenfortsAttention: 0.05,
    fenetrePanierSecondes: 2,
    partRenfortsAlerte: 0.15, partStopPoseApres: 0.25, partPileStop: 0.1, densitePileStop: 2, partAuDelaGaps: 0.2,
    fenetreStopVariable: 4, minPertesStopVariable: 30,
    dureeCourteSecondes: 60, partCourteAlerte: 0.3, partCourteAttention: 0.05,
    tauxReussiteSuspect: 0.85, ratioPerteGainSuspect: 3.0,
    perteJourMax: 0.05, perteTotaleMax: 0.10, minPositions: 20, creuxRisqueEleve: 0.4, creuxRisqueMoyen: 0.2,
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
   * DÉCISIONS (moteur v2, 26/11/2026). Les robots du Market ouvrent souvent PLUSIEURS positions pour une seule décision
   * (jambes à quelques secondes d'écart, 1 à 6 selon le signal) et font tourner plusieurs stratégies à la fois. Comparer
   * des positions ou des paniers de 2 s prenait ces différences pour des martingales et des grilles (13 robots du Market
   * vérifiés trade par trade le 26/11/2026). Une décision = entrées du même symbole et du même sens à moins de
   * r.fenetreDecisionSecondes (60 s) de la première. On garde : volume total, prix moyen, solde au moment d'ouvrir (le lot
   * qui suit le solde n'est pas une martingale), fermeture (la dernière jambe), résultat, et « protégée » = chaque jambe a
   * un stop-loss chez le courtier (dans l'ordre d'entrée, ou visible par une clôture « sl »).
   */
  function construireDecisions(positions, depot, mouvements, r) {
    const fenetre = r.fenetreDecisionSecondes * 1000;
    const tri = positions.slice().sort((a, b) => a.ouverture - b.ouverture);
    const fermees = positions.filter(fermee).sort((a, b) => a.fermeture - b.fermeture);
    const mvts = (mouvements || []).slice().sort((a, b) => a.temps - b.temps);
    let solde = depot, iF = 0, iM = 0;
    const derniere = new Map(), res = [];
    let stopConnu = false;
    // Stratégies nommées dans les commentaires (2 à 60, ≥ 70 % des positions) : deux stratégies qui entrent dans la même
    // minute restent deux décisions (sinon leurs tailles se mélangent).
    const strat = (p) => (p.commentaire || "").replace(/\.\d+$/, "").replace(/[\s_-]+(b|s|buy|sell|long|short)$/i, "").trim();
    const comptes = new Map();
    let commentees = 0;
    for (const p of positions) { const k = strat(p); if (k) { commentees++; comptes.set(k, (comptes.get(k) || 0) + 1); } }
    const parStrategie = comptes.size >= 2 && comptes.size <= 60 && commentees >= 0.7 * positions.length;
    for (const p of tri) {
      while (iF < fermees.length && fermees[iF].fermeture <= p.ouverture) solde += fermees[iF++].profit;
      while (iM < mvts.length && mvts[iM].temps <= p.ouverture) solde += mvts[iM++].montant;
      if (p.stopLoss !== null && p.stopLoss !== undefined) stopConnu = true;
      const cle = p.symbole + "|" + p.sens + (parStrategie ? "|" + strat(p) : ""), d = derniere.get(cle);
      const protegee = p.stopLoss > 0 || p.fermeParSL;
      if (d && p.ouverture - d.ouverture <= fenetre) {
        d.prixEntree = (d.prixEntree * d.volume + p.prixEntree * p.volume) / (d.volume + p.volume);
        d.volume = +(d.volume + p.volume).toFixed(8);
        d.jambes.push(p);
        d.protegee = d.protegee && protegee;
        continue;
      }
      const nd = { symbole: p.symbole, sens: p.sens, ouverture: p.ouverture, volume: p.volume, prixEntree: p.prixEntree,
        solde: Math.max(solde, 1e-9), jambes: [p], protegee };
      derniere.set(cle, nd);
      res.push(nd);
    }
    // Un stop ne protège vraiment que s'il est à une distance NORMALE pour ce robot (au plus 5× sa distance habituelle) et
    // qu'il ne laisse pas perdre plus de 25 % du compte : sinon une grille « déguisée » avec des stops très lointains
    // passerait pour protégée (contre-vérification du 26/11/2026). Valeur d'un point par lot retrouvée dans les trades.
    const distances = positions.filter((p) => p.stopLoss > 0).map((p) => Math.abs(p.prixEntree - p.stopLoss) / p.prixEntree).sort((a, b) => a - b);
    const distanceHabituelle = distances.length ? distances[distances.length >> 1] : null;
    const valeurs = new Map();
    for (const p of positions) {
      if (!fermee(p) || p.prixSortie === null || !(p.volume > 0)) continue;
      const ecart = (p.sens === "buy" ? 1 : -1) * (p.prixSortie - p.prixEntree);
      if (Math.abs(ecart) < 1e-9 || Math.abs(p.profit) < 1e-6) continue;
      const v = p.profit / (ecart * p.volume);
      if (v > 0) { if (!valeurs.has(p.symbole)) valeurs.set(p.symbole, []); valeurs.get(p.symbole).push(v); }
    }
    const valeurPoint = new Map([...valeurs].map(([k, v]) => [k, v.sort((a, b) => a - b)[v.length >> 1]]));
    for (const d of res) {
      const ouvertes = d.jambes.some((p) => !fermee(p));
      d.fermeture = ouvertes ? null : maxDe(d.jambes.map((p) => p.fermeture));
      d.profit = d.jambes.reduce((s, p) => s + p.profit, 0);
      d.n = d.jambes.length;
      const vp = valeurPoint.get(d.symbole);
      // perte si TOUS les stops de la décision sont touchés, en fraction du solde au moment d'ouvrir
      d.risqueAuStop = vp && d.jambes.every((p) => p.stopLoss > 0)
        ? d.jambes.reduce((s, p) => s + Math.abs(p.prixEntree - p.stopLoss) * p.volume * vp, 0) / d.solde : null;
      const stopNormal = (p) => p.fermeParSL || (p.stopLoss > 0 && (distanceHabituelle === null ||
        Math.abs(p.prixEntree - p.stopLoss) / p.prixEntree <= r.stopLointainFois * distanceHabituelle));
      d.protegee = d.jambes.every(stopNormal) && !(d.risqueAuStop !== null && d.risqueAuStop > r.risqueStopMax);
    }
    // Stops DÉCORATIFS : posés à l'entrée mais presque jamais touchés (moins de 5 % des pertes fermées « sl » sur au moins
    // 20 pertes) → ils ne protègent pas ; seules les jambes réellement fermées par leur stop restent protégées.
    // Robots du Market vérifiés : 25 à 89 % des pertes fermées par le stop.
    const pertes = positions.filter((p) => fermee(p) && p.profit < 0);
    const parSL = pertes.filter((p) => p.fermeParSL).length;
    res.stopsDecoratifs = stopConnu && pertes.length >= r.minPositions && parSL / pertes.length < r.partStopsTouchesMin;
    if (res.stopsDecoratifs) for (const d of res) d.protegee = d.jambes.every((p) => p.fermeParSL);
    res.stopConnu = stopConnu;
    res.distanceStopHabituelle = distanceHabituelle;
    return res;
  }

  /**
   * MARTINGALE : la mise grossit-elle À CAUSE des pertes ? On compare chaque décision à la précédente décision FERMÉE du
   * même symbole, en taille rapportée au solde (un lot qui suit le compte n'est pas une martingale), et on regarde la part
   * de hausses ×1,45 et plus APRÈS UNE PERTE et APRÈS UN GAIN. Une martingale grossit après les pertes et presque jamais
   * après les gains ; un robot à plusieurs stratégies ou à plusieurs jambes varie autant dans les deux cas.
   * Étalonnage du 26/11/2026 : martingales connues (MultiMartin, VR Overturn, LaboSynth ×2 et ×1,6 sur 19 marchés) =
   * 47 à 100 % de hausses après une perte, 0 % après un gain ; 13 robots du Market = écart de 9 points au plus.
   * Un DÉPÔT entre les deux décisions : pas de comparaison.
   */
  /** Comptage « après une perte / après un gain » ; groupe(d) = flux comparé (symbole, ou symbole + stratégie). */
  function compterHausses(decisions, groupe, depotEntre, r) {
    const fermeesD = decisions.filter((d) => d.fermeture !== null).sort((a, b) => a.fermeture - b.fermeture);
    const parFlux = new Map();
    for (const d of fermeesD) { const k = groupe(d); if (!parFlux.has(k)) parFlux.set(k, []); parFlux.get(k).push(d); }
    let apresPerte = 0, hausses = 0, apresGain = 0, haussesGain = 0, chaine = 0, chaineMax = 0, logPerte = 0, logGain = 0;
    const exemples = [];
    const tri = decisions.slice().sort((a, b) => a.ouverture - b.ouverture);
    for (const d of tri) {
      const liste = parFlux.get(groupe(d)) || [];
      let lo = 0, hi = liste.length;               // dernière décision fermée du même flux avant l'ouverture de d
      while (lo < hi) { const m = (lo + hi) >> 1; if (liste[m].fermeture <= d.ouverture) lo = m + 1; else hi = m; }
      const prev = lo > 0 ? liste[lo - 1] : null;
      if (!prev || prev === d || depotEntre(prev.fermeture, d.ouverture)) continue;
      const rel = (d.volume / d.solde) / (prev.volume / prev.solde);
      const hausse = rel >= r.ratioMartingale - EPS && d.volume > prev.volume + EPS;
      if (prev.profit < 0) {
        apresPerte++; logPerte += Math.log(Math.max(rel, 1e-6));
        if (hausse) {
          hausses++; chaine++; chaineMax = Math.max(chaineMax, chaine);
          if (exemples.length < 3) exemples.push({ t: d.ouverture, perte: prev.profit, v0: prev.volume, v1: d.volume });
        } else chaine = 0;
      } else {
        apresGain++; logGain += Math.log(Math.max(rel, 1e-6)); chaine = 0;
        if (hausse) haussesGain++;
      }
    }
    const part = apresPerte ? hausses / apresPerte : 0;
    const partGain = apresGain ? haussesGain / apresGain : 0;
    return { apresPerte, hausses, part: +part.toFixed(3), apresGain, haussesGain, partGain: +partGain.toFixed(3),
      ecart: +(part - partGain).toFixed(3), taillePerte: +Math.exp(apresPerte ? logPerte / apresPerte : 0).toFixed(2),
      tailleGain: +Math.exp(apresGain ? logGain / apresGain : 0).toFixed(2), chaineMax, exemples };
  }

  function niveauMartingale(m, r) {
    if (m.apresPerte >= r.minPertesMartingale && m.part >= r.partMartingaleAlerte && m.part - m.partGain >= r.ecartMartingaleAlerte) return "alerte";
    // Effet de TAILLE : en moyenne, la décision qui suit une perte est bien plus grosse que celle qui suit un gain (la
    // proportion de hausses est brouillée quand le nombre de positions par décision varie : LaboMulti, 26/11/2026).
    // Martingales connues : rapport 1,85 à plus de 3 ; 13 robots du Market : 1,32 au plus.
    if (m.apresPerte >= 2 * r.minPertesMartingale && m.apresGain >= r.minPertesMartingale && m.tailleGain > 0 &&
        m.taillePerte / m.tailleGain >= r.rapportTailleMartingaleAlerte && m.part - m.partGain >= r.ecartMartingaleAttention) return "alerte";
    if (m.hausses >= r.minEvenementsMartingale && m.part >= r.partMartingaleAttention && m.part - m.partGain >= r.ecartMartingaleAttention) return "attention";
    // « à surveiller » à DEUX conditions (écart ≥ 0,10 ET rapport de taille ≥ 1,3) : aucun robot non-martingale de la base ne
    // remplit les deux (EMA Cross : 0,12 mais 1,23 ; Gold Beaver : 0,07 et 1,31 ; grille plate : 1,67 mais écart ≤ 0,03).
    if (m.apresPerte >= 2 * r.minPertesMartingale && m.apresGain >= r.minPertesMartingale && m.tailleGain > 0 &&
        m.part - m.partGain >= r.ecartMartingaleAttention2 && m.taillePerte / m.tailleGain >= r.rapportTailleMartingaleAttention) return "attention";
    return "ok";
  }

  /**
   * Stratégie d'une décision, lue dans le COMMENTAIRE de ses ordres (« Janus S-7 B », « Moon Eclipse », « QT S01 »…) : on
   * retire le numéro de ticket (« .12 ») et le sens (B/S, Buy/Sell). Utilisable seulement si les commentaires découpent le
   * robot en 2 à 60 stratégies (pas un identifiant par trade, comme AiX Gold) et en couvrent au moins 70 %.
   */
  function strategieDe(d) {
    const c = (d.jambes[0].commentaire || "").replace(/\.\d+$/, "").replace(/[\s_-]+(b|s|buy|sell|long|short)$/i, "").trim();
    return c;
  }
  function strategiesUtilisables(decisions) {
    const n = new Map();
    let avec = 0;
    for (const d of decisions) { const k = strategieDe(d); if (k) { avec++; n.set(k, (n.get(k) || 0) + 1); } }
    return n.size >= 2 && n.size <= 60 && avec >= 0.7 * decisions.length;
  }

  /**
   * MARTINGALE : la mise grossit-elle À CAUSE des pertes ? On compare chaque décision à la précédente décision FERMÉE du
   * même symbole, en taille rapportée au solde (un lot qui suit le compte n'est pas une martingale), et on regarde la part
   * de hausses ×1,45 et plus APRÈS UNE PERTE et APRÈS UN GAIN. Une martingale grossit après les pertes et presque jamais
   * après les gains ; un robot à plusieurs stratégies ou à plusieurs jambes varie autant dans les deux cas.
   * Étalonnage du 26/11/2026 : martingales connues (MultiMartin, VR Overturn, LaboSynth ×2 et ×1,6 sur 19 marchés) =
   * 47 à 100 % de hausses après une perte, 0 % après un gain ; 13 robots du Market = écart de 9 points au plus.
   * PAR STRATÉGIE (campagne LaboMulti du 26/11/2026) : quand 5 stratégies tournent ensemble, chacune avec sa martingale,
   * la décision précédente est souvent celle d'une AUTRE stratégie et le lien se dilue (12 martingales sur 12 ratées). Si
   * les commentaires des ordres nomment les stratégies, le même test est refait stratégie par stratégie. Sans aucune
   * étiquette, une martingale répartie sur plusieurs stratégies reste indétectable (angle mort documenté).
   * Un DÉPÔT entre les deux décisions : pas de comparaison.
   */
  function detecterMartingale(decisions, r, unitaires, depots) {
    const fermeesD = decisions.filter((d) => d.fermeture !== null);
    if (fermeesD.length < r.minPositions) return pasAssez("martingale", fermeesD.length);
    const dep = (depots || []).slice().sort((a, b) => a - b);
    const depotEntre = (t0, t1) => dep.some((t) => t > t0 && t <= t1);
    const u = unitaires || [];
    const vMin = minDe(u.map((p) => p.volume));
    const mult = vMin ? maxDe(u.map((p) => p.volume)) / vMin : 1;
    const global = compterHausses(decisions, (d) => d.symbole, depotEntre, r);
    let niveau = niveauMartingale(global, r), cle = "martingale_" + niveau;
    let mesures = Object.assign({}, global, { mult: +mult.toFixed(2) });
    delete mesures.exemples;
    let exemples = global.exemples;
    if (niveau !== "alerte" && strategiesUtilisables(decisions)) {
      // chaque décision comparée à la précédente de SA stratégie ; résultats regroupés (toutes les données servent, même
      // quand chaque stratégie a peu de trades)
      const m = compterHausses(decisions, (d) => d.symbole + "|" + strategieDe(d), depotEntre, r);
      const n = niveauMartingale(m, r);
      const rang = { ok: 0, attention: 1, alerte: 2 };
      if (rang[n] > rang[niveau]) {
        // la stratégie la plus en cause, pour le texte
        let nomPire = null, ecartPire = -Infinity;
        for (const nom of new Set(decisions.map(strategieDe).filter(Boolean))) {
          const x = compterHausses(decisions.filter((d) => strategieDe(d) === nom), (d) => d.symbole, depotEntre, r);
          if (x.apresPerte >= 3 && x.ecart > ecartPire) { ecartPire = x.ecart; nomPire = nom; }
        }
        niveau = n; cle = "martingale_strategie";
        mesures = Object.assign({}, m, { strategie: nomPire || "?", niveauStrategie: n, mult: +mult.toFixed(2), partGlobale: global.part, partGainGlobale: global.partGain });
        delete mesures.exemples;
        exemples = m.exemples;
      }
    }
    return { code: "martingale", niveau, cle, donnees: mesures, mesures, exemples };
  }

  /**
   * GRILLE (moyenne à la baisse) : une nouvelle DÉCISION ouverte plus tard (> 60 s), à un prix MOINS BON que la pire
   * décision du même sens encore ouverte = un renfort. Une vraie grille renforce SANS stop sur chaque jambe (elle attend que
   * le prix revienne) ; un robot à plusieurs stratégies ouvre aussi des positions du même sens à moins bon prix, mais
   * chacune avec son propre stop-loss : ce n'est pas une grille (Gold Beaver, Allylla, Janus Zone, The Invincible…).
   * Étalonnage du 26/11/2026 : grilles connues (GridPro, GridEA, Zone Recovery, LaboSynth grilles sur 19 marchés) =
   * 20 à 69 % de décisions en renfort, 0 % de renforts protégés ; 13 robots du Market : renforts protégés à 100 %
   * sauf Scalping Robot Pro (46 %). Sans information de stop (historique de signal), on regarde si les renforts se
   * ferment avec la position qu'ils renforcent (panier).
   */
  function detecterGrille(decisions, r) {
    if (decisions.length < r.minPositions) return pasAssez("grille", decisions.length);
    const stopConnu = !!decisions.stopConnu;
    const ev = [];
    decisions.forEach((d) => {
      ev.push({ t: d.ouverture, o: 1, d });
      // À temps égal : fermetures d'abord, puis ouvertures ; une décision ouverte ET fermée dans la même seconde se ferme
      // APRÈS s'être ouverte (sinon elle restait « ouverte » pour toujours : pile de 1 995 chez un scalpeur, 26/11/2026)
      if (d.fermeture !== null) ev.push({ t: d.fermeture, o: d.fermeture === d.ouverture ? 2 : 0, d });
    });
    ev.sort((a, b) => a.t - b.t || a.o - b.o);
    const ouvertes = new Map();
    let simMax = 0, renforts = 0, nonProteges = 0, ensemble = 0, hausses = 0;
    const exemples = [], exemplesHausse = [];
    const fenetre = r.fenetreDecisionSecondes * 1000;
    for (const e of ev) {
      const cle = e.d.symbole + "|" + e.d.sens;
      if (!ouvertes.has(cle)) ouvertes.set(cle, []);
      const deja = ouvertes.get(cle);
      if (e.o !== 1) { const k = deja.indexOf(e.d); if (k >= 0) deja.splice(k, 1); continue; }
      const avant = deja.filter((x) => e.d.ouverture - x.ouverture > fenetre);
      if (avant.length) {
        const pire = avant.reduce((a, x) => (e.d.sens === "buy" ? (x.prixEntree < a.prixEntree ? x : a) : (x.prixEntree > a.prixEntree ? x : a)));
        const moinsBon = e.d.sens === "buy" ? e.d.prixEntree < pire.prixEntree - EPS : e.d.prixEntree > pire.prixEntree + EPS;
        if (moinsBon) {
          renforts++;
          if (!e.d.protegee) nonProteges++;
          if (e.d.fermeture !== null && pire.fermeture !== null && Math.abs(e.d.fermeture - pire.fermeture) <= r.fenetrePanierSecondes * 1000) ensemble++;
          if (e.d.volume >= pire.volume * r.ratioGrilleMartingale - EPS && e.d.volume > pire.volume + EPS) {
            hausses++;
            if (exemplesHausse.length < 3) exemplesHausse.push({ t: e.d.ouverture, rang: deja.length + 1, v0: pire.volume, v1: e.d.volume, symbole: e.d.symbole });
          }
          if (exemples.length < 3) exemples.push({ t: e.d.ouverture, rang: deja.length + 1, sens: e.d.sens, symbole: e.d.symbole, prix: e.d.prixEntree, avant: pire.prixEntree });
        }
      }
      deja.push(e.d);
      simMax = Math.max(simMax, deja.length);
    }
    const part = renforts / decisions.length;
    const partNonProteges = renforts ? nonProteges / renforts : 0;
    const partEnsemble = renforts ? ensemble / renforts : 0;
    // sans stop connu (signal) : un renfort qui se ferme avec la position renforcée compte comme non protégé
    // Grille réelle : renforts SANS stop crédible, OU renforts qui se ferment en PANIER avec la position renforcée (≥ 80 %).
    // Le panier démasque une grille « déguisée » qui pose un stop lointain sur chaque position (contre-vérification du
    // 26/11/2026 : 14 grilles connues sur 80 reconnues sans ce critère) ; les robots multi-stratégies du Market ferment
    // leurs renforts avec la position renforcée dans 6 à 67 % des cas seulement, les grilles connues dans 95 à 100 %.
    // Stops décoratifs (jamais touchés) : on ne parle de grille que si le robot EMPILE vraiment (≥ 5 décisions ouvertes
    // ensemble, GridEA) ; un robot qui coupe ses pertes lui-même sans empiler n'est pas une grille (Allylla : limite en
    // dollars, 3 positions au plus) — c'est l'affaire du contrôle du stop-loss.
    const sansStopCredible = stopConnu && partNonProteges >= r.partRenfortsNonProteges && (!decisions.stopsDecoratifs || simMax >= r.pileGrilleAlerte);
    const grilleReelle = sansStopCredible || partEnsemble >= r.partRenfortsPanier || (!stopConnu && partEnsemble >= r.partRenfortsNonProteges);
    const mesures = { simMax, defav: renforts, decisions: decisions.length, part: +part.toFixed(3), hausses,
      nonProteges, partNonProteges: +partNonProteges.toFixed(3), partEnsemble: +partEnsemble.toFixed(3), stopConnu };
    let niveau = "ok", cle = "grille_ok";
    // alerte : beaucoup de renforts, OU une pile d'au moins 5 positions du même sens (GridEA : 12 % de renforts mais
    // jusqu'à 111 positions ouvertes en même temps, aucune avec un stop)
    if (renforts >= r.minRenfortsGrilleAlerte && grilleReelle && (part >= r.partRenfortsAlerte || simMax >= r.pileGrilleAlerte)) niveau = "alerte";
    else if (renforts >= r.minEntreesGrille && part >= r.partRenfortsAttention && grilleReelle) niveau = "attention";
    if (niveau !== "ok") cle = "grille_" + niveau;
    else if (renforts >= r.minEntreesGrille && part >= r.partRenfortsAttention) cle = "grille_ok_proteges";   // empilement, chaque position avec son stop
    return { code: "grille", niveau, cle, donnees: mesures, mesures, exemples, exemplesHausse };
  }

  function detecterStopLoss(positions, r, clotureInconnue, grille) {
    const connues = positions.filter((p) => p.stopLoss !== null && p.stopLoss !== undefined);
    if (!connues.length) return clotureInconnue
      ? { code: "stop_loss", niveau: "inconnu", cle: "stop_export_positions", donnees: {}, mesures: {}, exemples: [] }
      : stopDeduit(positions, r, grille);
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
      const v = stopVirtuel(sans, r) || (grille ? null : stopVirtuelVariable(sans, r));
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
  function stopDeduit(positions, r, grille) {
    const pertes = positions.filter((p) => fermee(p) && p.profit < 0);
    const vide = { code: "stop_loss", niveau: "inconnu", cle: "stop_inconnu", donnees: {}, mesures: {}, exemples: [] };
    if (pertes.length < r.minPertesStopVirtuel) return vide;
    const parSL = pertes.filter((p) => p.fermeParSL).length;
    const mesures = { deduit: true, pertes: pertes.length, pertesParSL: parSL, partParSL: +(parSL / pertes.length).toFixed(3) };
    if (parSL >= r.minPertesStopVirtuel && parSL / pertes.length >= r.partStopPoseApres)
      return { code: "stop_loss", niveau: "ok", cle: "stop_constate", donnees: mesures, mesures, exemples: [] };
    const v = stopVirtuel(positions, r) || (grille ? null : stopVirtuelVariable(positions, r));
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

  /**
   * Stop virtuel dont la distance SUIT LA VOLATILITÉ (multiple de l'ATR…) : la distance de coupe change d'une période à
   * l'autre, donc pas de pile unique. On ramène chaque perte à la médiane des pertes voisines dans le temps (±4 pertes)
   * et on cherche la même pile sur ces distances relatives. Étalonnage 2026-11-23 (campagne de précision, 19 marchés) :
   * 15 stops ATR sur 19 retrouvés, aucune fausse détection sur les robots sans stop ni sur les grilles (exclues : leurs
   * pertes se ferment en panier, à des distances voisines). Fenêtre ±2 ou ±3 : fausses détections sur des grilles.
   */
  function stopVirtuelVariable(sansStop, r) {
    const pertes = sansStop.filter((p) => fermee(p) && p.profit < 0 && p.prixSortie !== null).sort((a, b) => a.fermeture - b.fermeture);
    if (pertes.length < r.minPertesStopVariable) return null;
    const d = pertes.map((p) => Math.abs(p.prixSortie - p.prixEntree));
    const W = r.fenetreStopVariable;
    const relatives = d.map((x, i) => {
      const voisins = d.slice(Math.max(0, i - W), i + W + 1).filter((y) => y > 0).sort((a, b) => a - b);
      const m = voisins[Math.floor(voisins.length / 2)];
      return { fermeture: 1, ouverture: 0, profit: -1, prixEntree: 1, prixSortie: m > 0 ? 1 + x / m : null, volume: 1 };
    });
    const v = stopVirtuel(relatives, r);
    if (!v) return null;
    return { virtuel: true, variable: true, pertesProches: v.pertesProches, pertes: v.pertes, partProches: v.partProches };
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

  /**
   * Pire série de pertes consécutives (en % du SOLDE au début de la série : avec un lot qui suit le solde, le % du dépôt
   * de départ n'a plus de sens — « −1 093 % du dépôt » sur Gold Beaver), exposition maximale (lots ouverts en même temps),
   * et taille qui suit le solde (intérêts composés : explique des résultats astronomiques en exécution parfaite).
   */
  function extremes(positions, depot, decisions) {
    const fermees = positions.filter(fermee).sort((a, b) => a.fermeture - b.fermeture);
    let n = 0, cumul = 0, solde = depot, soldeDebut = depot, pire = { n: 0, perte: 0, debut: null, fin: null, solde: depot }, debutSerie = null;
    for (const p of fermees) {
      if (p.profit < 0) {
        if (n === 0) { debutSerie = p.ouverture; soldeDebut = solde; }
        n++; cumul += p.profit;
        if (cumul / Math.max(soldeDebut, 1e-9) < pire.perte / Math.max(pire.solde, 1e-9) || (cumul === pire.perte && n > pire.n))
          pire = { n, perte: cumul, debut: debutSerie, fin: p.fermeture, solde: soldeDebut };
      } else { n = 0; cumul = 0; }
      solde += p.profit;
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
    // taille qui suit le solde : corrélation (décisions) entre volume et solde au moment d'ouvrir
    let taille = null;
    const D = decisions || [];
    if (D.length >= 20) {
      const xs = D.map((d) => d.solde), ys = D.map((d) => d.volume);
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
      const corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
      const vmin = minDe(ys), vmax = maxDe(ys);
      const soldeMax = maxDe(xs);
      const risques = D.map((d) => d.risqueAuStop).filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
      taille = { correlation: +corr.toFixed(3), mult: vmin > 0 ? +(vmax / vmin).toFixed(1) : null, soldeMax: +soldeMax.toFixed(2),
        suitSolde: corr >= 0.5 && vmin > 0 && vmax / vmin >= 10,
        // risque d'une décision si son stop est touché, en % du compte (médiane et 95e centile) : ce que le robot met en jeu
        risqueAuStopMedian: risques.length ? +risques[risques.length >> 1].toFixed(4) : null,
        risqueAuStopP95: risques.length ? +risques[Math.min(risques.length - 1, Math.floor(0.95 * risques.length))].toFixed(4) : null };
    }
    return {
      pireSerie: { pertes: pire.n, montant: +pire.perte.toFixed(2), pctDepot: depot ? +(-pire.perte / depot).toFixed(4) : null,
        pctSolde: pire.solde > 0 ? +(-pire.perte / pire.solde).toFixed(4) : null, soldeDebut: +pire.solde.toFixed(2), debut: pire.debut, fin: pire.fin },
      expositionMax: { lots: +expo.toFixed(2), foisMiseMin: vMin ? +(expo / vMin).toFixed(1) : null, quand, positionsSimultanees: simMax },
      taille,
    };
  }

  // ---------------------------------------------------------------- audit + verdict

  function auditer(backtest, reglages) {
    const r = Object.assign({}, REGLAGES, reglages || {});
    const positions = reconstruirePositions(backtest.transactions);
    const decisions = construireDecisions(positions, backtest.depot, backtest.mouvements, r);
    const dd = backtest.stats ? backtest.stats.drawdownEquiteMaxPct : undefined;
    const grille = detecterGrille(decisions, r);
    const liste = [
      detecterMartingale(decisions, r, positions, (backtest.mouvements || []).filter((m) => m.montant > 0).map((m) => m.temps)),
      grille,
      detecterStopLoss(positions, r, !!backtest.clotureInconnue, grille.niveau === "alerte"),
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
    if (c.martingale.niveau !== "alerte" && c.martingale.niveau !== "inconnu" && c.grille.niveau !== "ok" && gm.hausses >= r.minEntreesGrille && gm.hausses / gm.defav >= r.partGrilleMartingale) {
      const m = Object.assign({}, c.martingale.mesures, { haussesGrille: gm.hausses, defav: gm.defav });
      c.martingale = { code: "martingale", niveau: "alerte", cle: "martingale_grille", donnees: m, mesures: m, exemples: c.grille.exemplesHausse };
      liste[liste.findIndex((x) => x.code === "martingale")] = c.martingale;
    }
    const comportement = ["martingale", "grille", "stop_loss", "profil"].map((k) => c[k]);
    let risque;
    if (comportement.every((x) => x.niveau === "inconnu")) risque = "inconnu";
    else if (c.martingale.niveau === "alerte" || c.grille.niveau === "alerte") risque = "eleve";
    else if (c.stop_loss.niveau === "alerte" && c.profil.niveau === "alerte") risque = "eleve";
    // Le pire creux du capital compte aussi (26/11/2026) : un robot sans martingale ni grille qui perd 40 % ou plus de son
    // capital au pire moment n'est pas « faible » (Scalping Robot Pro : −36,7 % en exécution parfaite, −98,7 % sur vrais ticks).
    else if (dd !== undefined && dd !== null && dd >= r.creuxRisqueEleve) risque = "eleve";
    else if (comportement.some((x) => x.niveau === "alerte" || x.niveau === "attention") || (dd !== undefined && dd !== null && dd >= r.creuxRisqueMoyen)) risque = "moyen";
    else risque = "faible";
    let compatibleProp = null;
    const raisonsProp = ["prop", "trades_courts", "martingale", "grille"].filter((k) => c[k].niveau === "alerte");
    if (c.prop.niveau !== "inconnu") compatibleProp = raisonsProp.length === 0;
    const fermees = positions.filter(fermee);
    // Contrôle de cohérence (26/11/2026) : notre résultat net et notre nombre de sorties doivent être ceux que MetaTrader
    // affiche dans son propre rapport. Un écart = rapport mal lu → l'audit ne doit pas partir tel quel.
    const st = backtest.stats || {};
    let coherence = null;
    if (st.netMT5 !== undefined) {
      const net = fermees.reduce((x, p) => x + p.profit, 0);
      const sorties = backtest.transactions.filter((t) => t.entree === "out").length;
      const ecartNet = Math.abs(net - st.netMT5);
      const toleranceNet = Math.max(1, Math.abs(st.netMT5) * 1e-4);
      coherence = { netMT5: st.netMT5, netCalcule: +net.toFixed(2), ecartNet: +ecartNet.toFixed(2),
        tradesMT5: st.tradesMT5 ?? null, sortiesLues: sorties,
        ok: ecartNet <= toleranceNet && (st.tradesMT5 === undefined || st.tradesMT5 === sorties) };
    }
    return {
      coherence,
      backtest, positions, paniers: decisions.length, decisions: decisions.length, constats: c, risque, compatibleProp, raisonsProp,
      detectes: liste.filter((x) => x.niveau === "alerte").map((x) => x.code).sort(),
      resume: { positions: positions.length, fermees: fermees.length, net: fermees.reduce((s, p) => s + p.profit, 0) },
      extremes: extremes(positions, backtest.depot, decisions),
    };
  }

  const api = { parseMt5Report, parseSignalCsv, decode, reconstruirePositions, regrouperPaniers, construireDecisions, compterHausses, strategieDe, strategiesUtilisables, auditer, REGLAGES, fmtT, parseNum, parseTime, _rows: rows };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LaboEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
