output "instance_ocid" {
  description = "OCI instance identifier (not a secret)."
  value       = oci_core_instance.whatsapp.id
}

output "instance_public_ip" {
  description = "VM SSH address; do NOT publish internal service ports."
  value       = oci_core_instance.whatsapp.public_ip
}

output "ssh_example" {
  description = "Example SSH entry point; key should never be copied to the repo."
  value       = "ssh ubuntu@${oci_core_instance.whatsapp.public_ip}"
}
