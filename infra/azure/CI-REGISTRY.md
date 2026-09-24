# CI registry setup (Azure ACR or GitHub Container Registry)

Build images in GitHub Actions, push to a registry, pull on the VM in ~2–3 minutes instead of compiling on the VM.

## Option A — Azure Container Registry (recommended on Azure)

### 1. Create ACR (one time)

```bash
az provider register --namespace Microsoft.ContainerRegistry --wait   # first time only
./scripts/setup-ci-registry.sh
./scripts/setup-github-secrets.sh   # needs gh CLI, or add secrets manually
```

Or manually:

```bash
RESOURCE_GROUP=quanta-rg
ACR_NAME=quantadevclub   # must be globally unique, lowercase alphanumeric

az acr create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$ACR_NAME" \
  --sku Basic \
  --location southeastasia

az acr show --name "$ACR_NAME" --query loginServer -o tsv
# → quantadevclub.azurecr.io
```

### 2. GitHub repository configuration

**Variables** (Settings → Secrets and variables → Actions → Variables):

| Name | Example |
|------|---------|
| `ACR_LOGIN_SERVER` | `quantadevclub.azurecr.io` |
| `NEXT_PUBLIC_API_URL` | `https://quanta.devclub.in` |
| `NEXT_PUBLIC_WS_URL` | `wss://quanta.devclub.in` |

**Secrets**:

| Name | How to get |
|------|------------|
| `ACR_USERNAME` | `az acr credential show -n quantadevclub --query username -o tsv` |
| `ACR_PASSWORD` | `az acr credential show -n quantadevclub --query "passwords[0].value" -o tsv` |

### 3. Enable CI publish

Push to `main` runs `.github/workflows/publish-images.yml` and pushes:

```
quantadevclub.azurecr.io/quanta-api:sha-abc1234
quantadevclub.azurecr.io/quanta-api:latest
… (migrate, gateway, engine, scoring, web)
```

Manual run: Actions → **Publish Docker Images** → Run workflow.

### 4. Allow the VM to pull from ACR

```bash
# Managed identity (preferred)
az vm identity assign -g quanta-rg -n quanta-b2ms
ACR_ID=$(az acr show -n quantadevclub --query id -o tsv)
PRINCIPAL=$(az vm show -g quanta-rg -n quanta-b2ms --query identity.principalId -o tsv)
az role assignment create --assignee "$PRINCIPAL" --role AcrPull --scope "$ACR_ID"

# On VM — login once via managed identity (Azure CLI) or admin creds:
ssh -i ~/.ssh/quanta_azure azureuser@20.205.227.58
az login --identity   # if MI enabled
az acr login --name quantadevclub
```

Or use admin credentials on the VM:

```bash
az acr update -n quantadevclub --admin-enabled true
ssh ... 'sudo docker login quantadevclub.azurecr.io -u USER -p PASS'
```

### 5. Deploy from registry

```bash
REGISTRY=quantadevclub.azurecr.io \
IMAGE_TAG=sha-$(git rev-parse --short HEAD) \
./scripts/registry-vm-deploy.sh
```

Or with `SKIP_PROVISION=1` if the VM already exists (script does not provision).

---

## Option B — GitHub Container Registry (no Azure ACR)

Leave `ACR_LOGIN_SERVER` **unset**. The workflow publishes to:

```
ghcr.io/<your-github-org>/quanta-api:sha-abc1234
```

### 1. Make packages visible (if private repo)

Settings → Actions → General → Workflow permissions → **Read and write**.

For private GHCR packages, the VM needs a PAT:

```bash
# On VM
echo "$GITHUB_PAT" | sudo docker login ghcr.io -u YOUR_GITHUB_USER --password-stdin
```

Create PAT with `read:packages`.

### 2. Deploy

```bash
REGISTRY=ghcr.io/YOUR_ORG \
IMAGE_TAG=sha-$(git rev-parse --short HEAD) \
./scripts/registry-vm-deploy.sh
```

---

## Local scripts (on-VM build, no registry)

| Script | Purpose |
|--------|---------|
| `./scripts/changed-services.sh --git` | List services affected since last deploy |
| `./scripts/deploy-changed.sh` | Azure deploy, rebuild **only changed** services |
| `./scripts/deploy-changed.sh --all` | Force full rebuild |
| `BUILD_SERVICES="api web" ./scripts/azure-deploy.sh` | Explicit service list |
| `BUILD_ALL=1 SKIP_PROVISION=1 ./scripts/azure-deploy.sh` | Full rebuild, existing VM |

Last successful deploy ref is stored in `.deploy/last-commit` (local, gitignored).

---

## Typical timings

| Method | Typical duration |
|--------|----------------|
| `deploy-changed.sh` (one backend app) | **3–6 min** |
| `deploy-changed.sh` (web only) | **5–8 min** |
| `BUILD_ALL=1` on VM | **15–20 min** |
| `registry-vm-deploy.sh` (pull + up) | **2–4 min** |

---

## Troubleshooting

**`pull access denied`** — VM not logged in to registry; run `az acr login` or `docker login`.

**Web shows wrong API URL** — set `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` GitHub vars before building web in CI (values are baked at build time).

**Migrate runs every `up -d`** — expected; it exits quickly when schema is current.

**Compose still builds on VM** — when using registry mode, use `registry-vm-deploy.sh` or `compose pull` without `--build`.
