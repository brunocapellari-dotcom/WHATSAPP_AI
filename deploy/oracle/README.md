# Oracle Always Free — reproducible infrastructure candidate

**Status: infrastructure-as-code candidate, NOT deployed or tested against
a real OCI account.** No credentials are stored in this repository.

## What this provisions

- VCN `10.84.0.0/16`, public subnet `10.84.1.0/24`, internet gateway
  and route table. This is a **minimal** VM network, not the VCN Wizard's
  public-plus-private topology.
- Dedicated OCI A1 ARM64 VM, **2 OCPUs and 12 GB RAM**, boot volume **50 GB**,
  no reserved public IP, and only TCP/22 inbound **from one nominated /32**.
- No NAT gateway, load balancer, bastion, block-volume backup service,
  monitoring subscription, extra block volumes, paid database, or public
  application ports. Ubuntu via verified ARM64 image OCID, supplied locally.
- `prevent_destroy = true` makes accidental Terraform destruction of the
  instance fail. Do not delete resources just to resolve plan conflicts.

This creates a **new** VCN: if one was already created manually, reuse/import
it deliberately rather than duplicating it. Inspect the account first.

## Hard gate before any plan/apply

OCI Always Free A1 limits must be verified in **the actual tenancy**. OCI's
current documented allowance for Always Free tenancies is **1,500 OCPU-hours
and 9,000 GB-hours per month** (equivalent to 2 OCPUs and 12GB for ~750 hours);
boot and block volumes share the free-volume allowance. Never use a
historical 4 OCPU/24GB figure without checking account entitlements.

1. OCI CLI must already be installed and signed in privately using
   `oci setup config` / another supported auth method. Do not expose
   `~/.oci/config`, API signing keys, or Terraform state.
2. Verify the tenancy **home region** from `oci iam region-subscription list
   --tenancy-id TENANCY_OCID`. The instance must be in this region.
3. Inventory **all** VM.Standard.A1.Flex instances and boot/block volumes
   consuming the Always Free quota, including other compartments and
   availability domains. Check current tenancy limits and cost/usage
   in the OCI console. Verify your chosen instance is still free after
   existing utilization, including boot storage. Capacity is not guaranteed.
4. Confirm the shape `VM.Standard.A1.Flex` is available in the selected
   availability domain, and select a verified **Ubuntu ARM64** image OCID
   for the region. Do not guess or use x86_64 image IDs.
5. Confirm `admin_ssh_ipv4_cidr` is your current trusted IPv4 **/32** and
   that the corresponding .pub key is correct. Keep its private key offline.
6. Confirm no existing instance/VCN would be duplicated or modified.
   Never execute `apply` with a plan that deletes or replaces resources.
7. Only after these checks change all three *verified* booleans to `true`
   in the local `terraform.tfvars`.

## Running the candidate — no unattended paid resources

From `deploy/oracle` in your **private local checkout**, not GitHub Actions:

```sh
cp terraform.tfvars.example terraform.tfvars
# Edit all placeholders and check/confirm the gate booleans after inventory.
terraform init
terraform fmt -check
terraform validate
terraform plan -out=oci.tfplan
terraform show oci.tfplan
# Carefully verify 7 intended NEW resources, no deletes/replaces,
# no unexpected cost or tenancy mismatch before:
terraform apply oci.tfplan
terraform output ssh_example
```

OCI authentication is required for plan/apply. `terraform validate`
and the CI job do not access your OCI account and **do not** prove free quota.
OCI's Terraform provider uses the authenticated local OCI profile/environment.

Do not copy Terraform state, plan files or `.tfvars` to git/cloud CI. Protect
local Terraform state and keep an encrypted recoverable backup in an
approved private location.

## Next stage AFTER a real A1 VM is accessible

1. Confirm SSH works from nominated /32, kernel architecture
   `uname -m` = `aarch64`, disk and memory.
2. Install Docker/Compose using supported Ubuntu packaging.
3. Inspect `deploy/local/docker-compose.yml` and
   `deploy/server/docker-compose.arm64.yml`, build/test ARM64 WPPConnect
   **before starting** the whole stack. Do not run `deploy/local/start.sh`
   blindly on the server (it is a workstation script).
4. Use local-only encrypted .env secrets, run PostgreSQL migrations,
   municipal sync, health checks, report generation, backup and restore.
   Do NOT enable sender/profile `send` during technical deployment.
5. QR pairing requires human presence. Access WPPConnect locally via
   SSH tunnel, never by opening port 21465 publicly.
6. Allowlist real groups and a recipient only with approval. Perform two
   observed inbound cycles and an explicitly approved outbound test.
7. Mark production live only after all go-live gates pass.

The ARM64 Docker image candidate is under `deploy/server/`; the pinned
upstream WPPConnect image is AMD64-only and cannot simply be used on A1.

## Operational caveats

A dynamic residential IP can change; updating the SSH /32 requires plan/apply
with the new verified IP. A public SSH IP exposes only the administrative SSH
endpoint, not the application. Default Ubuntu OS firewall should also be
checked. Avoid OCI upgrades and trial credits. A capacity error is a
blocker, not permission to provision a paid alternative.

Official reference: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
