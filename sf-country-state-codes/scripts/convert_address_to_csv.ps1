# Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
# or distribute this software without written permission.

<#
.SYNOPSIS
  Optional extra: convert an already-retrieved Address.settings-meta.xml to CSV.

.DESCRIPTION
  Needs no Python. Reads the XML, writes one row per state (or one row per country
  without states), sorted by Country then State, UTF-8 CSV with a BOM (Excel opens it correctly).
  Runs in Windows PowerShell 5.1 (powershell) and PowerShell 7 (pwsh).
  It does not call Salesforce. Retrieve the file first, for example:
      sf project retrieve start --metadata Settings:Address --target-org my-sandbox

.EXAMPLE
  .\convert_address_to_csv.ps1
  .\convert_address_to_csv.ps1 -XmlPath .\Address.settings-meta.xml -OutFile .\codes.csv
#>
param(
    [string]$XmlPath = ".\force-app\main\default\settings\Address.settings-meta.xml",
    [string]$OutFile = ".\Country_State_Codes.csv"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $XmlPath)) {
    throw "Address settings XML not found: $XmlPath"
}

[xml]$xml = Get-Content -LiteralPath $XmlPath -Raw -Encoding UTF8

$countries = $xml.AddressSettings.countriesAndStates.countries
if (-not $countries) {
    throw "No countries found under AddressSettings/countriesAndStates in $XmlPath"
}

function New-Row($country, $state) {
    [PSCustomObject]@{
        Country                      = [string]$country.label
        'Country Code'               = [string]$country.isoCode
        'Country Integration Value'  = [string]$country.integrationValue
        'Country Active'             = [string]$country.active
        'Country Visible'            = [string]$country.visible
        'Country Salesforce Standard' = [string]$country.standard
        'Country Org Default'        = [string]$country.orgDefault
        State                        = if ($state) { [string]$state.label } else { "" }
        'State Code'                 = if ($state) { [string]$state.isoCode } else { "" }
        'State Integration Value'    = if ($state) { [string]$state.integrationValue } else { "" }
        'State Active'               = if ($state) { [string]$state.active } else { "" }
        'State Visible'              = if ($state) { [string]$state.visible } else { "" }
        'State Salesforce Standard'  = if ($state) { [string]$state.standard } else { "" }
    }
}

$rows = foreach ($country in $countries) {
    if ($country.states) {
        foreach ($state in $country.states) { New-Row $country $state }
    }
    else {
        New-Row $country $null
    }
}

# UTF-8 WITH a byte order mark in Windows PowerShell 5.1 and PowerShell 7 alike, so Excel
# shows accented names correctly. (Export-Csv -Encoding UTF8 has no BOM in PowerShell 7.)
$lines = $rows |
    Sort-Object Country, State |
    ConvertTo-Csv -NoTypeInformation
$target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutFile)
[System.IO.File]::WriteAllLines($target, [string[]]@($lines), (New-Object System.Text.UTF8Encoding $true))

Write-Host "Created $OutFile with $(@($rows).Count) rows."
