"""Спільні функції проекту digits-cnn (заняття 4.10)."""
import json
import os
import random
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SPLIT_PATH = ROOT / "data" / "splits.npz"
RESULTS = ROOT / "results"


def load_config():
    with open(ROOT / "config.json", encoding="utf-8") as f:
        return json.load(f)


def set_seed(seed):
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    np.random.seed(seed)
    try:
        import tensorflow as tf
        tf.keras.utils.set_random_seed(seed)
    except ImportError:
        pass


def load_digits_images():
    """Повертає X (n, 8, 8) у діапазоні [0, 1] та y (n,)."""
    from sklearn.datasets import load_digits
    d = load_digits()
    return (d.images / 16.0).astype("float32"), d.target.astype("int64")


def load_split():
    """Завантажує зафіксований split (створюється у 01_data.ipynb)."""
    X, y = load_digits_images()
    idx = np.load(SPLIT_PATH)
    return {part: (X[idx[part]], y[idx[part]]) for part in ("train", "val", "test")}


def add_noise(X, sigma, seed=0):
    rng = np.random.default_rng(seed)
    return np.clip(X + rng.normal(0, sigma, X.shape), 0, 1).astype("float32")


def shift_images(X, pixels=1, seed=0):
    """Зсуває кожне зображення на `pixels` пікселів у випадковому напрямку (з нулями на краю)."""
    rng = np.random.default_rng(seed)
    out = np.zeros_like(X)
    for i, img in enumerate(X):
        dy, dx = rng.choice([-pixels, 0, pixels], size=2)
        out[i] = np.roll(np.roll(img, dy, axis=0), dx, axis=1)
        if dy > 0: out[i, :dy, :] = 0
        if dy < 0: out[i, dy:, :] = 0
        if dx > 0: out[i, :, :dx] = 0
        if dx < 0: out[i, :, dx:] = 0
    return out


def build_cnn(filters=(32, 64), dense=64, dropout=0.0, l2=0.0, augment=False,
              translation=0.125, rotation=0.04, lr=1e-3, n_classes=10):
    import tensorflow as tf
    from tensorflow.keras import layers, regularizers

    reg = regularizers.l2(l2) if l2 else None
    inp = layers.Input(shape=(8, 8, 1))
    x = inp
    if augment:  # аугментація активна лише під час навчання
        x = layers.RandomTranslation(translation, translation, fill_mode="constant")(x)
        x = layers.RandomRotation(rotation, fill_mode="constant")(x)
    x = layers.Conv2D(filters[0], 3, padding="same", activation="relu", kernel_regularizer=reg)(x)
    x = layers.Conv2D(filters[0], 3, padding="same", activation="relu", kernel_regularizer=reg)(x)
    x = layers.MaxPooling2D()(x)                       # 8x8 -> 4x4
    x = layers.Conv2D(filters[1], 3, padding="same", activation="relu", kernel_regularizer=reg)(x)
    x = layers.MaxPooling2D()(x)                       # 4x4 -> 2x2
    x = layers.Flatten()(x)
    x = layers.Dense(dense, activation="relu", kernel_regularizer=reg)(x)
    if dropout:
        x = layers.Dropout(dropout)(x)
    out = layers.Dense(n_classes, activation="softmax")(x)
    model = tf.keras.Model(inp, out)
    model.compile(optimizer=tf.keras.optimizers.Adam(lr),
                  loss="sparse_categorical_crossentropy", metrics=["accuracy"])
    return model
