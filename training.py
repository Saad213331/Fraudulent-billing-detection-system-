"""Train the provider-level XGBoost model and save model/fraud_model.joblib.

Usage:
    python training.py [train_claims_csv] [labels_csv]
"""
import os
import sys

import joblib
import pandas as pd
from sklearn.feature_selection import SelectKBest
from sklearn.metrics import (accuracy_score, average_precision_score, f1_score, precision_recall_curve,
                             precision_score, recall_score, roc_auc_score)
from sklearn.model_selection import StratifiedKFold, cross_val_predict, train_test_split
from sklearn.pipeline import Pipeline
from xgboost import XGBClassifier

import features as F

TRAIN_CSV = sys.argv[1] if len(sys.argv) > 1 else "data/train_imputed.csv"
LABELS_CSV = sys.argv[2] if len(sys.argv) > 2 else "data/Train-1542865627584.csv"
OUT = "model/fraud_model.joblib"

# Load claims and attach the provider labels
claims = F.read_claims(TRAIN_CSV)
if "PotentialFraud" not in claims.columns:
    claims = claims.merge(pd.read_csv(LABELS_CSV), on="Provider", how="left", validate="m:1")

# One row per provider, with the fraud label
prov = F.build_provider_table(claims)
prov["target"] = (claims.groupby("Provider")["PotentialFraud"].first() == "Yes").astype(int)
print("Providers:", len(prov), "| fraud share:", round(prov["target"].mean(), 4))

# 80/20 stratified split by provider (never by claim)
train_idx, val_idx = train_test_split(prov.index.to_numpy(), test_size=0.2, stratify=prov["target"].to_numpy(), random_state=42)
ytr, yva = prov.loc[train_idx, "target"], prov.loc[val_idx, "target"]

# Fit the feature steps on the training providers only
pre = F.FraudPreprocessor().fit(prov.loc[train_idx])
Xtr, Xva = pre.transform(prov.loc[train_idx]), pre.transform(prov.loc[val_idx])
print("Features kept after variance and correlation filters:", Xtr.shape[1])

# Mutual-information selection (top 20) + XGBoost, kept in one pipeline
pipe = Pipeline([
    ("sel", SelectKBest(F.mi_score, k=20)),
    ("xgb", XGBClassifier(subsample=1.0, scale_pos_weight=1, reg_lambda=5, n_estimators=200, min_child_weight=3,
                          max_depth=6, learning_rate=0.05, gamma=0, colsample_bytree=0.8,
                          eval_metric="logloss", random_state=42)),
])

# Best F1 threshold from out-of-fold predictions on the training data only
skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
oof = cross_val_predict(pipe, Xtr, ytr, cv=skf, method="predict_proba")[:, 1]
p, r, t = precision_recall_curve(ytr, oof)
thr = float(t[(2 * p * r / (p + r + 1e-9))[:-1].argmax()])
pipe.fit(Xtr, ytr)

# Validation metrics
prob = pipe.predict_proba(Xva)[:, 1]
pred = (prob >= thr).astype(int)
metrics = {
    "accuracy": float(accuracy_score(yva, pred)),
    "precision": float(precision_score(yva, pred)),
    "recall": float(recall_score(yva, pred)),
    "f1": float(f1_score(yva, pred)),
    "roc_auc": float(roc_auc_score(yva, prob)),
    "pr_auc": float(average_precision_score(yva, prob)),
    "n_train_providers": int(len(train_idx)),
    "n_val_providers": int(len(val_idx)),
}

# Feature importance of the 20 selected features
chosen = Xtr.columns[pipe.named_steps["sel"].get_support()]
scores = pipe.named_steps["xgb"].feature_importances_
importance = {k: round(float(v), 4) for k, v in sorted(zip(chosen, scores), key=lambda kv: -kv[1])}

print("Threshold:", round(thr, 3))
for k, v in metrics.items():
    print(f"{k:18s}", round(v, 3) if isinstance(v, float) else v)

os.makedirs("model", exist_ok=True)
joblib.dump({"pre": pre, "pipe": pipe, "thr": thr, "metrics": metrics, "importance": importance}, OUT)
print("Saved", OUT)
