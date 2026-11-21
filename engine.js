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
    const ddTxt = findStat(allRows, [/equity drawdown maximal/, /drawdown maximal.*(fonds|équité|equite)/, /drawdown.*équité.*maximal/]);
    if (ddTxt) {
      const m = /\(([\d.,\s]+)%\)/.exec(ddTxt);
      if (m) stats.drawdownEquiteMaxPct = parseNum(m[1]) / 100;
    }

    const temps = transactions.map((t) => t.temps);
    return {
      backtest: {
        robot: findStat(allRows, [/^expert/]) || "Robot",
        symbole: findStat(allRows, [/^symbol/, /^symbole/]) || transactions[0].symbole,
        periode: (findStat(allRows, [/^period/, /^période/]) || "").replace(/\s*\(.*\)\s*$/, ""),
        debut: Math.min.apply(null, temps),
        fin: Math.max.apply(null, temps),
        depot,
        transactions,
        stats,
        scenario: "rapport fourni",
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
    ratioMartingale: 1.5, minEvenementsMartingale: 3, partMartingaleAlerte: 0.3, chaineMartingaleAlerte: 3,
    maxPositionsGrilleAlerte: 3, minEntreesGrille: 3,
    partSansStopAlerte: 0.5, partSansStopAttention: 0.1,
    minPertesStopVirtuel: 10, toleranceStopVirtuel: 0.15, partStopVirtuel: 0.7,
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

  function detecterMartingale(positions, r) {
    const fermees = positions.filter(fermee);
    if (fermees.length < r.minPositions) return pasAssez("martingale", fermees.length);
    const parOuverture = positions.slice().sort((a, b) => a.ouverture - b.ouverture);
    const parFermeture = fermees.slice().sort((a, b) => a.fermeture - b.fermeture);
    let apresPerte = 0, hausses = 0, chaine = 0, chaineMax = 0, i = 0, derniere = null;
    const exemples = [];
    const vMin = Math.min.apply(null, positions.map((p) => p.volume));
    const mult = vMin ? Math.max.apply(null, positions.map((p) => p.volume)) / vMin : 1;
    for (const p of parOuverture) {
      while (i < parFermeture.length && parFermeture[i].fermeture <= p.ouverture) derniere = parFermeture[i++];
      if (!derniere) continue;
      if (derniere.profit < 0) {
        apresPerte++;
        if (p.volume >= derniere.volume * r.ratioMartingale) {
          hausses++; chaine++; chaineMax = Math.max(chaineMax, chaine);
          if (exemples.length < 3) exemples.push({ t: p.ouverture, perte: derniere.profit, v0: derniere.volume, v1: p.volume });
        } else chaine = 0;
      } else chaine = 0;
    }
    const part = apresPerte ? hausses / apresPerte : 0;
    const mesures = { apresPerte, hausses, part: +part.toFixed(3), chaineMax, mult: +mult.toFixed(2) };
    const alerte = (hausses >= r.minEvenementsMartingale && part >= r.partMartingaleAlerte) || chaineMax >= r.chaineMartingaleAlerte;
    const niveau = alerte ? "alerte" : hausses > 0 ? "attention" : "ok";
    return { code: "martingale", niveau, cle: "martingale_" + niveau, donnees: mesures, mesures, exemples };
  }

  function detecterGrille(positions, r) {
    if (positions.length < r.minPositions) return pasAssez("grille", positions.length);
    const ev = [];
    positions.forEach((p) => {
      ev.push({ t: p.ouverture, o: 1, p });
      if (fermee(p)) ev.push({ t: p.fermeture, o: 0, p });
    });
    ev.sort((a, b) => a.t - b.t || a.o - b.o);
    const ouvertes = new Map();
    let simMax = 0, defav = 0, hausses = 0;
    const exemples = [], exemplesHausse = [];
    for (const e of ev) {
      const cle = e.p.symbole + "|" + e.p.sens;
      if (!ouvertes.has(cle)) ouvertes.set(cle, []);
      const deja = ouvertes.get(cle);
      if (!e.o) {
        const k = deja.indexOf(e.p);
        if (k >= 0) deja.splice(k, 1);
        continue;
      }
      if (deja.length) {
        const d = deja[deja.length - 1];
        const pire = e.p.sens === "buy" ? e.p.prixEntree < d.prixEntree : e.p.prixEntree > d.prixEntree;
        if (pire) {
          defav++;
          if (e.p.volume >= d.volume * r.ratioMartingale - EPS) {
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
    // « à surveiller » : au moins minEntreesGrille renforts. Étalonnage 2026-11-21 : Crossing MA (robot propre,
    // lot fixe, SL) fait 2 renforts en 87 positions par simple répétition de signal → ne doit pas être signalé.
    else if (simMax >= 2 && defav >= r.minEntreesGrille) niveau = "attention";
    return { code: "grille", niveau, cle: "grille_" + niveau, donnees: mesures, mesures, exemples, exemplesHausse };
  }

  function detecterStopLoss(positions, r) {
    const connues = positions.filter((p) => p.stopLoss !== null && p.stopLoss !== undefined);
    if (!connues.length) return { code: "stop_loss", niveau: "inconnu", cle: "stop_inconnu", donnees: {}, mesures: {}, exemples: [] };
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
      if (pertes.length >= r.minPertesStopVirtuel && parSL / pertes.length >= r.partStopVirtuel) {
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
    const proches = d.filter((x) => Math.abs(x - med) <= r.toleranceStopVirtuel * med).length;
    const part = proches / n;
    if (part < r.partStopVirtuel) return null;
    // Points estimés d'après le niveau de prix (5 décimales < 10, 3 décimales < 1000, sinon 2).
    const prix = sansStop[0].prixEntree;
    const point = prix < 10 ? 1e-5 : prix < 1000 ? 1e-3 : 1e-2;
    return { virtuel: true, distance: +med.toFixed(6), points: Math.round(med / point), pertesProches: proches, pertes: n, partProches: +part.toFixed(3) };
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
    const mesures = { taux: +taux.toFixed(3), gainMoyen: +gm.toFixed(2), perteMoyenne: +pm.toFixed(2), ratio: +ratio.toFixed(2), pire: pertes.length ? +Math.max.apply(null, pertes).toFixed(2) : 0 };
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
    const vMin = positions.length ? Math.min.apply(null, positions.map((p) => p.volume)) : 0;
    return {
      pireSerie: { pertes: pire.n, montant: +pire.perte.toFixed(2), pctDepot: depot ? +(-pire.perte / depot).toFixed(4) : null, debut: pire.debut, fin: pire.fin },
      expositionMax: { lots: +expo.toFixed(2), foisMiseMin: vMin ? +(expo / vMin).toFixed(1) : null, quand, positionsSimultanees: simMax },
    };
  }

  // ---------------------------------------------------------------- audit + verdict

  function auditer(backtest, reglages) {
    const r = Object.assign({}, REGLAGES, reglages || {});
    const positions = reconstruirePositions(backtest.transactions);
    const dd = backtest.stats ? backtest.stats.drawdownEquiteMaxPct : undefined;
    const liste = [
      detecterMartingale(positions, r),
      detecterGrille(positions, r),
      detecterStopLoss(positions, r),
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
      backtest, positions, constats: c, risque, compatibleProp, raisonsProp,
      detectes: liste.filter((x) => x.niveau === "alerte").map((x) => x.code).sort(),
      resume: { positions: positions.length, fermees: fermees.length, net: fermees.reduce((s, p) => s + p.profit, 0) },
      extremes: extremes(positions, backtest.depot),
    };
  }

  const api = { parseMt5Report, decode, reconstruirePositions, auditer, REGLAGES, fmtT, parseNum, parseTime, _rows: rows };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LaboEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
