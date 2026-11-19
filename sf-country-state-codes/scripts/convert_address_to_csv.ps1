<#
.SYNOPSIS
  Optional extra: convert an already-retrieved Address.settings-meta.xml to CSV.

.DESCRIPTION
  Needs no Python. Reads the XML, writes one row per state (or one row per country
  without states), sorted by Country then State, UTF-8 CSV.
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
        Country                   = [string]$country.label
        CountryCode               = [string]$country.isoCode
        CountryIntegrationValue   = [string]$country.integrationValue
        CountryActive             = [string]$country.active
        CountryVisible            = [string]$country.visible
        CountrySalesforceStandard = [string]$country.standard
        CountryOrgDefault         = [string]$country.orgDefault
        State                     = if ($state) { [string]$state.label } else { "" }
        StateCode                 = if ($state) { [string]$state.isoCode } else { "" }
        StateIntegrationValue     = if ($state) { [string]$state.integrationValue } else { "" }
        StateActive               = if ($state) { [string]$state.active } else { "" }
        StateVisible              = if ($state) { [string]$state.visible } else { "" }
        StateSalesforceStandard   = if ($state) { [string]$state.standard } else { "" }
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

$rows |
    Sort-Object Country, State |
    Export-Csv -LiteralPath $OutFile -NoTypeInformation -Encoding UTF8

Write-Host "Created $OutFile with $(@($rows).Count) rows."
