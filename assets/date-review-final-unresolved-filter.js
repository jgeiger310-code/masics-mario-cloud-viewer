(() => {
  "use strict";
  const remaining = new Set([1, 2, 3, 4, 5, 6, 7, 8, 16, 17, 18, 19, 46, 47, 48, 49, 52, 53, 98, 99, 100, 102, 103, 104, 132, 133, 160, 165, 178, 223, 224, 250, 274, 278, 279, 280, 281, 282, 283, 284, 293, 303, 312, 321, 322, 323, 324, 325, 330, 363, 450, 461, 482, 483, 488, 498, 505, 506, 507, 509, 511, 566, 567, 575, 577, 581, 601, 657, 673, 674, 677, 678, 679, 680, 681, 682, 683, 700, 701, 702, 703, 704, 716, 720, 721, 722, 734, 742, 743, 760, 764, 765, 789, 790, 817]);
  const all = window.MARIO_DATE_REVIEW_DATA || [];
  window.MARIO_DATE_REVIEW_DATA = all.filter(r => remaining.has(Number(r[0])));
  window.MARIO_FINAL_RECHECK_COUNTS = {total:137, resolved:42, remaining:95, filenameDate:31, ocrDescriptor:10, scheduleDateClue:1};
})();
