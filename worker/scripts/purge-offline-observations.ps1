param(
  [ValidateRange(1, 250)]
  [int]$BatchSize = 250,
  [ValidateRange(1, 40)]
  [int]$Batches = 1
)

# Run only after a verified sparse-firmware scan. Each deleted row and index
# entry counts toward D1 writes, so keep this deliberately small.
for ($index = 1; $index -le $Batches; $index++) {
  $sql = "DELETE FROM scan_devices WHERE rowid IN (SELECT rowid FROM scan_devices WHERE online=0 LIMIT $BatchSize); SELECT changes() AS deleted_rows;"
  npx.cmd wrangler d1 execute DB --remote --command $sql
  if ($LASTEXITCODE -ne 0) {
    throw "D1 cleanup batch $index failed."
  }
}
