(function () {
  document.querySelectorAll(".search-block").forEach(function (block) {
    var input = block.querySelector(".post-search");
    var cards = Array.prototype.slice.call(block.querySelectorAll(".post-card"));
    var empty = block.querySelector(".search-empty");
    var emptyQ = block.querySelector(".search-empty-q");
    if (!input || cards.length === 0) return;

    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      var visible = 0;
      cards.forEach(function (card) {
        var hay = card.getAttribute("data-search") || "";
        var match = q === "" || hay.indexOf(q) !== -1;
        card.hidden = !match;
        if (match) visible++;
      });
      if (empty) {
        empty.hidden = !(q !== "" && visible === 0);
        if (emptyQ) emptyQ.textContent = input.value.trim();
      }
    });
  });
})();
