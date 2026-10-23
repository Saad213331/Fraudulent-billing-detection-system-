"""Shared scoring helper: claim-level DataFrame in, one scored row per provider out."""
import joblib
import pandas as pd

import features as F

# Raw features that are shown in the dashboard (same order as in the CSV)
RAW_COLS = ["n_claims", "n_bene", "reimb_sum", "reimb_mean", "reimb_max", "ip_ratio", "dup_ratio",
            "round_ratio", "n_proc_mean", "n_diag_mean", "claims_per_bene", "reimb_per_bene"]


def load_model(path="model/fraud_model.joblib"):
    return joblib.load(path)


def score_claims(df, model):
    """Build the provider table, predict, and return the scored provider table."""
    prov = F.build_provider_table(df)
    prob = model["pipe"].predict_proba(model["pre"].transform(prov))[:, 1]
    thr = model["thr"]
    out = pd.DataFrame({"Provider": prov.index, "fraud_probability": prob.round(4)})
    out["predicted_fraud"] = (out["fraud_probability"] >= thr).map({True: "Yes", False: "No"})
    out["risk_level"] = "Low"
    out.loc[out["fraud_probability"] >= thr / 2, "risk_level"] = "Medium"
    out.loc[out["fraud_probability"] >= thr, "risk_level"] = "High"
    for col in RAW_COLS:
        out[col] = prov[col].round(4).values
    return out.sort_values("fraud_probability", ascending=False).reset_index(drop=True)
