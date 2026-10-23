"""Provider-level feature engineering (same steps as the notebook).

Public interface used by the other scripts:
    check_columns(df)            -> list of missing required columns
    build_provider_table(df)     -> one row per provider (claims are never scored one by one)
    FraudPreprocessor            -> fit(prov) / transform(prov) -> model-ready features
"""
import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.feature_selection import VarianceThreshold, mutual_info_classif
from sklearn.preprocessing import KBinsDiscretizer, PolynomialFeatures, PowerTransformer, StandardScaler

REQUIRED = [
    "Provider", "BeneID", "ClaimType", "ClaimStartDt", "ClaimEndDt", "DOB", "InscClaimAmtReimbursed",
    "DeductibleAmtPaid", "AttendingPhysician", "State", "ClmDiagnosisCode_1", "n_diag", "n_proc", "stay_days",
]
POLY = ["reimb_mean", "n_diag_mean", "claims_per_bene"]
BIN = ["reimb_mean", "age_mean", "claims_per_bene"]


def mi_score(a, b):
    """Mutual information with a fixed seed (a named function, so joblib can save the pipeline)."""
    return mutual_info_classif(a, b, random_state=42)


def read_claims(path):
    """Read a claim-level CSV. keep_default_na=False keeps the text 'None' as a real category."""
    return pd.read_csv(path, keep_default_na=False, na_values=[""], low_memory=False)


def check_columns(df):
    """Return the list of required columns that are missing from the file."""
    return [col for col in REQUIRED if col not in df.columns]


def _claim_level(df):
    """Step 1: add claim-level helper features."""
    chronic = [x for x in df.columns if x.startswith("ChronicCond_")]
    c = df[REQUIRED + chronic].copy()
    for col in ["ClaimStartDt", "ClaimEndDt", "DOB"]:
        c[col] = pd.to_datetime(c[col], errors="coerce")
    c["claim_days"] = (c["ClaimEndDt"] - c["ClaimStartDt"]).dt.days + 1
    c["age"] = (c["ClaimStartDt"] - c["DOB"]).dt.days / 365.25
    c["chronic_count"] = (c[chronic] == 1).sum(axis=1)
    c["is_ip"] = (c["ClaimType"] == "IP").astype(int)
    c["amt_per_day"] = c["InscClaimAmtReimbursed"] / c["claim_days"].clip(lower=1)
    c["round_amount"] = ((c["InscClaimAmtReimbursed"] % 100 == 0) & (c["InscClaimAmtReimbursed"] > 0)).astype(int)
    c["dup_claim"] = c.duplicated(["Provider", "BeneID", "ClaimStartDt"], keep=False).astype(int)
    c["no_attending"] = (c["AttendingPhysician"].isna() | (c["AttendingPhysician"] == "Missing")).astype(int)
    c["is_weekend"] = (c["ClaimStartDt"].dt.dayofweek >= 5).astype(int)
    c["year_month"] = c["ClaimStartDt"].dt.to_period("M").astype(str)
    return c


def build_provider_table(df):
    """Step 2: aggregate claims to one row per provider (index = Provider).

    The column dx_text holds the provider's diagnosis codes as one text string (used for TF-IDF).
    """
    missing = check_columns(df)
    if missing:
        raise ValueError(f"Missing required columns: {missing}")
    c = _claim_level(df)
    g = c.groupby("Provider")
    p = pd.DataFrame({
        "n_claims": g.size(),
        "n_bene": g["BeneID"].nunique(),
        "reimb_sum": g["InscClaimAmtReimbursed"].sum(),
        "reimb_mean": g["InscClaimAmtReimbursed"].mean(),
        "reimb_max": g["InscClaimAmtReimbursed"].max(),
        "reimb_std": g["InscClaimAmtReimbursed"].std().fillna(0),
        "ded_mean": g["DeductibleAmtPaid"].mean(),
        "n_diag_mean": g["n_diag"].mean(),
        "n_proc_mean": g["n_proc"].mean(),
        "stay_days_mean": g["stay_days"].mean(),
        "claim_days_mean": g["claim_days"].mean(),
        "age_mean": g["age"].mean(),
        "chronic_mean": g["chronic_count"].mean(),
        "amt_per_day_mean": g["amt_per_day"].mean(),
        "ip_ratio": g["is_ip"].mean(),
        "weekend_ratio": g["is_weekend"].mean(),
        "round_ratio": g["round_amount"].mean(),
        "dup_ratio": g["dup_claim"].mean(),
        "no_attending_ratio": g["no_attending"].mean(),
        "n_active_months": g["year_month"].nunique(),
        "active_days": (g["ClaimStartDt"].max() - g["ClaimStartDt"].min()).dt.days + 1,
        "n_attending": g["AttendingPhysician"].nunique(),
        "n_states": g["State"].nunique(),
        "top_state": g["State"].agg(lambda s: s.mode().iloc[0]).astype(str),
    })
    p["claims_per_bene"] = p["n_claims"] / p["n_bene"]
    p["reimb_per_bene"] = p["reimb_sum"] / p["n_bene"]
    p["claims_per_active_day"] = p["n_claims"] / p["active_days"]
    dx = c.loc[c["ClmDiagnosisCode_1"].notna() & (c["ClmDiagnosisCode_1"] != "None")]
    docs = dx.groupby("Provider")["ClmDiagnosisCode_1"].apply(lambda s: " ".join(s.astype(str)))
    p["dx_text"] = docs.reindex(p.index).fillna("")
    return p


class FraudPreprocessor:
    """Steps 3 to 12: TF-IDF, encoding, interactions, polynomial, bins, Yeo-Johnson, scaling, selection.

    Everything is fitted on the training providers only, so nothing leaks from validation or test data.
    """

    def fit(self, prov):
        P = prov.drop(columns=["target"], errors="ignore")
        self.med = P.drop(columns=["top_state", "dx_text"]).replace([np.inf, -np.inf], np.nan).median()
        self.tfidf = TfidfVectorizer(max_features=15, token_pattern=r"\S+", lowercase=False).fit(P["dx_text"])
        self.tf_cols = ["tfidf_" + t for t in self.tfidf.get_feature_names_out()]
        self.top5 = P["top_state"].value_counts().head(5).index.tolist()
        self.freq = P["top_state"].value_counts(normalize=True)
        self.cats = self.top5 + ["Other"]
        self.poly = PolynomialFeatures(degree=2, include_bias=False).fit(P[POLY])
        names = self.poly.get_feature_names_out(POLY)
        self.new_idx = [i for i, n in enumerate(names) if n not in POLY]
        self.new_names = ["poly_" + names[i].replace("^2", "_sq").replace(" ", "_x_") for i in self.new_idx]
        self.kb = KBinsDiscretizer(n_bins=5, encode="ordinal", strategy="quantile").fit(P[BIN])
        X = self._expand(P)
        cont = [col for col in X.columns if (not col.startswith(("state_", "tfidf_")) or col == "state_freq")]
        cont = [col for col in cont if not col.endswith("_bin") and X[col].nunique() > 10]
        self.skewed = [col for col in cont if abs(X[col].skew()) > 1]
        self.pt = PowerTransformer(method="yeo-johnson", standardize=False).fit(X[self.skewed])
        X[self.skewed] = self.pt.transform(X[self.skewed])
        self.SC = [col for col in X.columns if col == "state_freq" or not col.startswith("state_")]
        self.sc = StandardScaler().fit(X[self.SC])
        X[self.SC] = self.sc.transform(X[self.SC])
        vt = VarianceThreshold(0.01).fit(X)
        f1 = [col for col, keep in zip(X.columns, vt.get_support()) if keep]
        corr = X[f1].corr().abs()
        upper = corr.where(np.triu(np.ones(corr.shape, dtype=bool), k=1))
        self.f2 = [col for col in f1 if not (upper[col] > 0.95).any()]
        return self

    def _expand(self, P):
        X = P.drop(columns=["target", "dx_text"], errors="ignore").copy()
        num = self.med.index
        X[num] = X[num].replace([np.inf, -np.inf], np.nan).fillna(self.med)
        T = self.tfidf.transform(P["dx_text"]).toarray()
        for j, name in enumerate(self.tf_cols):
            X[name] = T[:, j]
        X["state_freq"] = X["top_state"].map(self.freq).fillna(0)
        grp = pd.Series(pd.Categorical(np.where(X["top_state"].isin(self.top5), X["top_state"], "Other"),
                                       categories=self.cats), index=X.index)
        dummies = pd.get_dummies(grp, prefix="state").astype(int)
        for col in dummies.columns:
            X[col] = dummies[col]
        X = X.drop(columns="top_state")
        X["ip_x_reimb"] = X["ip_ratio"] * X["reimb_mean"]
        X["diag_x_proc"] = X["n_diag_mean"] * X["n_proc_mean"]
        X["chronic_x_age"] = X["chronic_mean"] * X["age_mean"]
        X["dup_x_claims"] = X["dup_ratio"] * X["n_claims"]
        Pm = self.poly.transform(X[POLY])
        for i, name in zip(self.new_idx, self.new_names):
            X[name] = Pm[:, i]
        B = self.kb.transform(X[BIN])
        for j, col in enumerate(BIN):
            X[col + "_bin"] = B[:, j]
        return X

    def transform(self, prov):
        X = self._expand(prov)
        X[self.skewed] = self.pt.transform(X[self.skewed])
        X[self.SC] = self.sc.transform(X[self.SC])
        return X[self.f2].replace([np.inf, -np.inf], np.nan).fillna(0)
