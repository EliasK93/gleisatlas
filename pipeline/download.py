"""Download one monthly source file from the public HuggingFace dataset into data/raw/."""

from huggingface_hub import hf_hub_download

REPO = "piebro/deutsche-bahn-data"


def download(month: str, local_dir: str = "data/raw") -> str:
    """`month` is 'YYYY-MM', as `pipeline.update.remote_months` lists them.
    ponytail: no pinned dataset `revision`, so a month re-uploaded upstream and the months processed
    before can come from different upstream states without notice; record the dataset commit in
    `meta` and reprocess the months whose commit differs when upstream corrections matter."""
    return hf_hub_download(
        REPO,
        f"monthly_processed_data/data-{month}.parquet",
        repo_type="dataset",
        local_dir=local_dir,
    )
