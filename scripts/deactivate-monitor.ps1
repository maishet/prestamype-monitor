[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$')][string]$StackName = "prestamype-monitor",
    [ValidatePattern('^[a-z]{2}-[a-z]+-\d$')][string]$Region = "sa-east-1",
    [switch]$ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ($ValidateOnly -or $WhatIfPreference) { Write-Output "Validación local correcta; AWS no fue invocado."; return }
$tableName = & aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or $tableName -notmatch '^[A-Za-z0-9_.-]{3,255}$') { throw "No se pudo resolver TableName de forma segura." }
$tempPath = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
try {
    $request = @{ TableName = $tableName; Key = @{ PK = @{ S = "CONFIG" }; SK = @{ S = "MONITOR" } }; UpdateExpression = "SET enabled = :disabled REMOVE activation_owner"; ExpressionAttributeValues = @{ ":disabled" = @{ BOOL = $false } } }
    [IO.File]::WriteAllText($tempPath, ($request | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))
    & aws dynamodb update-item --region $Region --cli-input-json ("file://" + $tempPath) --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "No se pudo deshabilitar el monitor." }
} finally { if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force } }
Write-Output "Monitor deshabilitado; no se eliminó ningún dato."
