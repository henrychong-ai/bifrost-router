import { createContext } from 'react';
import type { FilterContextValue } from './filter-types';

export const FilterContext = createContext<FilterContextValue | null>(null);
