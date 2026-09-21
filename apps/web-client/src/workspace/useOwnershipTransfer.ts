import { useState } from 'react';
import {
  applyOwnershipTransfer,
  dryRunOwnershipTransfer,
  type OwnershipTransferImpact,
} from '../api/client.ts';
import { presentFailure, type PresentedFailure } from './failures.ts';

export function useOwnershipTransfer() {
  const [transferImpact, setTransferImpact] = useState<OwnershipTransferImpact | null>(null);
  const [transferImpactPending, setTransferImpactPending] = useState(false);
  const [transferPending, setTransferPending] = useState(false);
  const [transferFailure, setTransferFailure] = useState<PresentedFailure | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);

  return {
    transferImpact,
    transferImpactPending,
    transferPending,
    transferFailure,
    sessionEnded,
    reviewTransfer: (memberId: string): void => {
      setTransferImpactPending(true);
      setTransferFailure(null);
      setTransferImpact(null);
      dryRunOwnershipTransfer(memberId).then(
        (impact) => {
          setTransferImpactPending(false);
          setTransferImpact(impact);
        },
        (error: unknown) => {
          setTransferImpactPending(false);
          setTransferFailure(presentFailure(error));
        },
      );
    },
    applyTransfer: (input: {
      readonly memberId: string;
      readonly previewId: string;
      readonly expectedRevision: number;
      readonly confirmation: string;
    }): void => {
      setTransferPending(true);
      setTransferFailure(null);
      applyOwnershipTransfer(input).then(
        () => {
          setTransferPending(false);
          setTransferImpact(null);
          setSessionEnded(true);
        },
        (error: unknown) => {
          setTransferPending(false);
          const failure = presentFailure(error);
          if (failure.kind === 'conflict') setTransferImpact(null);
          setTransferFailure(failure);
        },
      );
    },
    cancelTransfer: (): void => {
      setTransferImpact(null);
      setTransferFailure(null);
    },
  };
}
