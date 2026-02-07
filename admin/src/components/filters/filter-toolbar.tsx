import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { X, Search } from 'lucide-react';
import { DOMAINS } from '@/lib/schemas';

/**
 * Common countries for the country filter datalist
 */
const COMMON_COUNTRIES = [
  { code: 'US', name: 'United States' },
  { code: 'SG', name: 'Singapore' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'AU', name: 'Australia' },
  { code: 'DE', name: 'Germany' },
  { code: 'JP', name: 'Japan' },
  { code: 'CN', name: 'China' },
  { code: 'IN', name: 'India' },
] as const;

/**
 * Days preset options
 */
const DAYS_PRESETS = [
  { value: '1', label: '24 hours' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
] as const;

export interface FilterState {
  search?: string;
  search2?: string;
  domain?: string;
  country?: string;
  days?: number;
}

export interface FilterToolbarProps {
  /**
   * Current filter values
   */
  filters: FilterState;
  /**
   * Callback when any filter changes
   */
  onFiltersChange: (filters: FilterState) => void;
  /**
   * Callback when reset button is clicked (in addition to filter reset)
   * Use this to reset pagination or other page-level state
   */
  onReset?: () => void;
  /**
   * Override for showing the reset button (default: auto-detect based on active filters)
   */
  showReset?: boolean;
  /**
   * Label for the primary search input
   */
  searchLabel?: string;
  /**
   * Placeholder for the primary search input
   */
  searchPlaceholder?: string;
  /**
   * Label for the secondary search input (optional)
   */
  search2Label?: string;
  /**
   * Placeholder for the secondary search input (optional)
   */
  search2Placeholder?: string;
  /**
   * Show the domain filter
   */
  showDomain?: boolean;
  /**
   * Show the country filter
   */
  showCountry?: boolean;
  /**
   * Show the days filter
   */
  showDays?: boolean;
  /**
   * CSS class name
   */
  className?: string;
}

export function FilterToolbar({
  filters,
  onFiltersChange,
  onReset,
  showReset,
  searchLabel = 'Search',
  searchPlaceholder = 'Search...',
  search2Label,
  search2Placeholder,
  showDomain = true,
  showCountry = true,
  showDays = true,
  className = '',
}: FilterToolbarProps) {
  const handleSearchChange = (value: string) => {
    onFiltersChange({ ...filters, search: value || undefined });
  };

  const handleSearch2Change = (value: string) => {
    onFiltersChange({ ...filters, search2: value || undefined });
  };

  const handleDomainChange = (value: string) => {
    onFiltersChange({ ...filters, domain: value === 'all' ? undefined : value });
  };

  const handleCountryChange = (value: string) => {
    // Normalize to uppercase and limit to 2 characters
    const normalized = value.toUpperCase().slice(0, 2);
    onFiltersChange({ ...filters, country: normalized || undefined });
  };

  const handleDaysChange = (value: string) => {
    onFiltersChange({ ...filters, days: parseInt(value, 10) });
  };

  const handleResetClick = () => {
    onFiltersChange({
      search: undefined,
      search2: undefined,
      domain: undefined,
      country: undefined,
      days: 1,
    });
    // Call external reset callback for page-level state (e.g., pagination)
    onReset?.();
  };

  const hasActiveFilters =
    filters.search ||
    filters.search2 ||
    filters.domain ||
    filters.country ||
    (filters.days && filters.days !== 1);

  // Use showReset prop if provided, otherwise auto-detect based on active filters
  const shouldShowReset = showReset ?? hasActiveFilters;

  return (
    <div className={`flex flex-wrap items-end gap-3 ${className}`}>
      {/* Primary Search Input */}
      <div className="flex flex-col gap-1.5">
        <label className="text-small font-gilroy text-charcoal-600">
          {searchLabel}
        </label>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal-400" />
          <Input
            type="text"
            placeholder={searchPlaceholder}
            value={filters.search || ''}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-8 w-48 font-gilroy"
          />
        </div>
      </div>

      {/* Secondary Search Input (optional) */}
      {search2Label && (
        <div className="flex flex-col gap-1.5">
          <label className="text-small font-gilroy text-charcoal-600">
            {search2Label}
          </label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal-400" />
            <Input
              type="text"
              placeholder={search2Placeholder || `Search ${search2Label.toLowerCase()}...`}
              value={filters.search2 || ''}
              onChange={(e) => handleSearch2Change(e.target.value)}
              className="pl-8 w-48 font-gilroy"
            />
          </div>
        </div>
      )}

      {/* Domain Filter */}
      {showDomain && (
        <div className="flex flex-col gap-1.5">
          <label className="text-small font-gilroy text-charcoal-600">
            Domain
          </label>
          <Select
            value={filters.domain || 'all'}
            onValueChange={handleDomainChange}
          >
            <SelectTrigger className="w-48 font-gilroy">
              <SelectValue placeholder="All domains" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="font-gilroy">
                All domains
              </SelectItem>
              {DOMAINS.map((domain) => (
                <SelectItem key={domain} value={domain} className="font-gilroy">
                  {domain}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Country Filter */}
      {showCountry && (
        <div className="flex flex-col gap-1.5">
          <label className="text-small font-gilroy text-charcoal-600">
            Country
          </label>
          <Input
            type="text"
            placeholder="e.g. US, SG"
            value={filters.country || ''}
            onChange={(e) => handleCountryChange(e.target.value)}
            list="country-suggestions"
            className="w-28 font-gilroy uppercase"
            maxLength={2}
          />
          <datalist id="country-suggestions">
            {COMMON_COUNTRIES.map(({ code, name }) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </datalist>
        </div>
      )}

      {/* Days Filter */}
      {showDays && (
        <div className="flex flex-col gap-1.5">
          <label className="text-small font-gilroy text-charcoal-600">
            Time Range
          </label>
          <Select
            value={String(filters.days || 1)}
            onValueChange={handleDaysChange}
          >
            <SelectTrigger className="w-32 font-gilroy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAYS_PRESETS.map(({ value, label }) => (
                <SelectItem key={value} value={value} className="font-gilroy">
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Reset Button */}
      {shouldShowReset && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleResetClick}
          className="font-gilroy text-charcoal-500 hover:text-charcoal-700"
        >
          <X className="h-4 w-4 mr-1" />
          Reset
        </Button>
      )}
    </div>
  );
}
