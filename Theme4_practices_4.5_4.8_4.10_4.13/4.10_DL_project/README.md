# Практичне завдання 4.10 — `digits-cnn`

**Індивідуальний mini-project. Варіант 1 — Image classification:** класифікація рукописних цифр 8×8, порівняння простого baseline з CNN, перевірка augmentation і domain shift.

## 1. Problem contract
- **Input:** зображення рукописної цифри 8×8 (64 пікселі, інтенсивність 0…1).
- **Target:** клас 0–9.
- **Користувач:** аналітик, який автоматизує розпізнавання рукописних цифр у відсканованих бланках.
- **Чому DL:** у зображень є просторова структура; CNN має бути стійкішою до зсувів і шуму, ніж лінійна модель на сирих пікселях.
- **Success criterion (зафіксовано до експериментів):** macro-F1 на тесті ≥ 0.97 **і** перевага над baseline на чистих даних, із шумом і зі зсувом.

## 2. Дані
Відкритий UCI *Optical Recognition of Handwritten Digits*, вбудований у scikit-learn (`load_digits`): 1797 зображень, 10 збалансованих класів. Data card — у [`data/README.md`](data/README.md) і `notebooks/01_data.ipynb`. Інтернет не потрібен, чутливих даних немає.

**Split:** stratified train/val/test = 60/20/20 (1077/360/360), seed 42, індекси збережено в `data/splits.npz`. Точних дублікатів немає. Test використано один раз — після вибору FINAL за validation.

## 3. Як запустити
```bash
pip install -r requirements.txt
cd notebooks
jupyter nbconvert --to notebook --execute --inplace 01_data.ipynb 02_baseline.ipynb 03_dl_experiment.ipynb
```
Усі гіперпараметри — у `config.json`, спільний код — `src/utils.py`. Час виконання на CPU ≈ 3–4 хв. Перевірено: Python 3.12, TensorFlow 2.21, scikit-learn 1.9.

## 4. Таблиця експериментів
Метрика — macro-F1. Для D1–D3: середнє з 3 seeds (42, 43, 44). «Val shift» — validation, де кожне зображення зсунуто на 1 px; «Val noise» — гаусів шум σ = 0.15. Selection score = (clean + (noise + shift)/2) / 2.

| Run | Hypothesis | Change | Train | Validation | Gap | Val noise | Val shift | Std (seeds) | Time, s | Decision |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| B0 | baseline | LogReg на пікселях, C=10 | 0.999 | 0.975 | 0.024 | 0.947 | 0.351 | — | 0.04 | reference |
| D1 | DL should capture spatial structure | base CNN (45k params) | 0.997 | 0.984 | 0.014 | 0.961 | 0.528 | 0.006 | 11 | rejected |
| D2 | regularization may reduce overfit | + Dropout 0.3, L2 1e-4 | 0.999 | **0.988** | **0.011** | **0.971** | 0.577 | 0.007 | 13 | rejected |
| D3 | augmentation may improve generalization under shift | + augmentation (±1 px, ±~15°) | 0.994 | 0.981 | 0.013 | 0.954 | **0.957** | 0.018 | 19 | **selected → FINAL** |
| FINAL | selected by validation | D3, seed 42, frozen | — | — | — | — | — | — | — | final test |

Повна таблиця: [`results/experiments.csv`](results/experiments.csv).

## 5. Final result (test, 360 зображень)
| Модель | clean | noise σ=0.15 | shift 1 px |
|---|---:|---:|---:|
| B0 LogReg | **0.958** | 0.938 | 0.341 |
| FINAL (D3 CNN) | 0.952 | 0.938 | **0.908** |

Файли: [`results/metrics.csv`](results/metrics.csv), [`results/error_analysis.md`](results/error_analysis.md), модель `results/final_model.keras`.

## 6. Analytical brief
**Що отримано.** На «чистих» центрованих зображеннях CNN **не перевершила** сильний лінійний baseline (0.952 проти 0.958 — різниця в межах 2 зображень із 360 і менша за розкид між seeds). Але за зсуву зображення лише на 1 піксель baseline руйнується (0.34 — модель масово прогнозує «4»), тоді як CNN з аугментацією зберігає 0.91. Тобто success criterion **виконано лише частково**: перевага DL доведена для стійкості до зсуву, але не для точності на ідеально підготовлених даних.

**Що показали контрольовані експерименти.**
- D1 → D2: регуляризація трохи зменшила generalization gap (0.014 → 0.011) і дала найкращу clean-validation, але стійкість до зсуву майже не змінилась (0.53 → 0.58) — сама архітектура CNN на 8×8 мало інваріантна до зсуву.
- D2 → D3: аугментація — ключовий фактор: val shift 0.58 → 0.96 ціною −0.7 п.п. на чистих даних і більшої варіативності між seeds (std 0.018).

**Де модель працює / не працює.** Працює на зсунутих і зашумлених цифрах; найчастіші помилки — 8→1, 1→2, 9→4, 9→7 (схожі штрихи при роздільності 8×8). Помилкові прогнози мають значно нижчу впевненість (≈0.65 проти ≈0.98), тому поріг впевненості можна використати для передачі сумнівних зразків людині.

**Limitations.**
- Тест (360 зображень) малий: різниця в 1 п.п. ≈ 3–4 зображення, тобто статистично не значуща.
- Test виявився складнішим за validation для обох моделей (−1.7…−2.9 п.п.); оцінка одного split + одного seed для FINAL нестабільна (std D3 = 0.018). Правильніше — повторний k-fold або ансамбль seeds.
- У версії sklearn немає ідентифікаторів авторів почерку → неможливий split за авторами, можливий optimistic bias.
- Синтетичний domain shift (шум, зсув) не охоплює реальні артефакти сканування (розмиття, нахил, інша роздільність).

**Next step.** (1) Обирати FINAL з ансамблю 3 seeds D3 або з k-fold, щоб зменшити варіативність; (2) додати аугментацію шумом; (3) перевірити на справжньому зовнішньому наборі (наприклад, MNIST, зменшений до 8×8) як реальний domain shift.

## 7. Peer-review checklist (самоперевірка)
1. Аналітичне питання — розпізнавання цифр у бланках, стійкість до зсуву — ✔ (розд. 1).
2. Split відтворюваний — ✔ `data/splits.npz`, seed у `config.json`.
3. Baseline на тому самому протоколі — ✔ B0 на тих самих train/val/test і тих самих shift/noise.
4. Test не використовувався для tuning — ✔ правило вибору зафіксовано до запуску, test — одна клітинка після `final_model.save`.
5. Архітектура обґрунтована — ✔ 2 pooling під 8×8, ~45k параметрів під ~1k зразків.
6. Evidence overfit/underfit — ✔ колонка Gap, криві loss.
7. Failure cases показані — ✔ матриці плутанини, зображення помилок, `error_analysis.md`.
8. Seeds, versions, hyperparameters — ✔ `config.json`, `requirements.txt`, розд. 3.
9. Credentials / sensitive data — відсутні ✔.
10. Висновок не перебільшує — ✔ прямо вказано, що на чистих даних DL перевагу не дало.

## Структура
```text
4.10_DL_project/
├── README.md
├── config.json
├── requirements.txt
├── data/README.md, splits.npz
├── notebooks/01_data.ipynb, 02_baseline.ipynb, 03_dl_experiment.ipynb
├── src/utils.py
└── results/metrics.csv, experiments.csv, error_analysis.md, baseline.json, final_model.keras
```
