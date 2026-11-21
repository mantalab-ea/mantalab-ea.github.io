// Robots d'exemple simulés (comportement connu), utilisés par la page et par les tests.
(function (root) {
  "use strict";
  const H = 3600 * 1000;
  const T0 = Date.UTC(2024, 0, 1, 9);

  function bt(robot, tx) {
    return { robot, symbole: "EURUSD", periode: "H1", debut: T0, fin: tx[tx.length - 1].temps, depot: 10000, transactions: tx, stats: {} };
  }
  const tin = (t, sens, v, prix, sl) => ({ temps: t, symbole: "EURUSD", sens, entree: "in", volume: v, prix, commission: 0, swap: 0, profit: 0, stopLoss: sl });
  const tout = (t, sens, v, prix, profit) => ({ temps: t, symbole: "EURUSD", sens, entree: "out", volume: v, prix, commission: 0, swap: 0, profit, stopLoss: null });

  function martingale() {
    const tx = [];
    let vol = 0.01;
    for (let i = 0; i < 40; i++) {
      const o = T0 + 3 * i * H;
      const perte = i % 4 !== 3;
      tx.push(tin(o, "buy", vol, 1.1, 0));
      tx.push(tout(o + H, "sell", vol, 1.1, perte ? -1000 * vol : 4000 * vol));
      vol = perte ? +(vol * 2).toFixed(8) : 0.01;
    }
    return bt("Exemple martingale", tx);
  }

  function propre() {
    const tx = [];
    for (let i = 0; i < 40; i++) {
      const o = T0 + 5 * i * H;
      tx.push(tin(o, "buy", 0.1, 1.1, 1.095));
      tx.push(tout(o + 2 * H, "sell", 0.1, 1.1, i % 2 === 0 ? 60 : -40));
    }
    return bt("Exemple propre", tx);
  }

  function grille() {
    const tx = [];
    for (let panier = 0; panier < 10; panier++) {
      const d = T0 + 48 * panier * H;
      for (let k = 0; k < 4; k++) tx.push(tin(d + k * H, "buy", 0.1, +(1.1 - 0.002 * k).toFixed(5), 0));
      for (let k = 0; k < 4; k++) tx.push(tout(d + 6 * H, "sell", 0.1, 1.099, 5));
    }
    return bt("Exemple grille", tx);
  }

  const api = { martingale, propre, grille, T0, H };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LaboExemples = api;
})(typeof window !== "undefined" ? window : globalThis);
