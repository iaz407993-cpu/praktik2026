# Тема 4 — практичні завдання 4.5, 4.8, 4.10, 4.13

Усі ноутбуки виконані, з виводами та графіками.

| Завдання | Папка | Зміст | Ключовий результат |
|---|---|---|---|
| 4.5 | `4.5_Titanic_classification/` | Kaggle Titanic: LogReg, KNN, Random Forest, SVM; метрики, матриці плутанини, ROC | LogReg: accuracy 0.844, F1 0.794, AUC 0.874 |
| 4.8 | `4.8_TF_regression_classification/` | Варіант **N = 5**: 5000 зразків, 7 класів; нейромережі Keras | MSE 242 (R² 0.988, у 7.8× краще за лінійну); accuracy 0.959 |
| 4.10 | `4.10_DL_project/` | Mini-project (Варіант 1): baseline vs CNN, D1–D3, domain shift, error analysis, README/config/results | CNN ≈ baseline на чистих даних (0.952 vs 0.958), але 0.908 vs 0.341 при зсуві на 1 px |
| 4.13 | `4.13_TransferLearning_RL/` | Fine-tuning MobileNetV2 (rural/urban) + RL-агенти Q-learning і DQN для маршруту | Test 100% vs 85% з нуля; DQN знайшов оптимальний маршрут |

Встановлення: `pip install tensorflow scikit-learn pandas matplotlib seaborn pillow jupyter`.
