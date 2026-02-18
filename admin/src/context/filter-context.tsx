import { useState, useCallback, type ReactNode } from 'react';
import { FilterContext } from './filter-context-value';
import {
  DEFAULT_FILTERS,
  type PageFilters,
  type PageKey,
} from './filter-types';

export function FilterProvider({ children }: { children: ReactNode }) {
  const [filters, setFiltersState] = useState<PageFilters>(DEFAULT_FILTERS);

  const getFilters = useCallback(
    <K extends PageKey>(page: K): PageFilters[K] => {
      return filters[page];
    },
    [filters],
  );

  const setFilters = useCallback(
    <K extends PageKey>(page: K, newFilters: PageFilters[K]) => {
      setFiltersState(prev => ({
        ...prev,
        [page]: newFilters,
      }));
    },
    [],
  );

  const resetFilters = useCallback((page: PageKey) => {
    setFiltersState(prev => ({
      ...prev,
      [page]: DEFAULT_FILTERS[page],
    }));
  }, []);

  return (
    <FilterContext.Provider value={{ getFilters, setFilters, resetFilters }}>
      {children}
    </FilterContext.Provider>
  );
}
